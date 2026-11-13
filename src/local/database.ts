/*
 * Copyright (c) 2026 valo.media GmbH
 * All rights reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {
    DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand
} from '@aws-sdk/client-dynamodb';
import type {Database, DatabaseCommand, DatabaseItem} from '../application';

interface Table {
    key: string;
    items: Map<string, DatabaseItem>;
}

/**
 * Implements only the commands issued by the shared handlers, not general DynamoDB semantics.
 * Unsupported queries and updates fail rather than silently pretending to work.
 */
export class MemoryDatabase implements Database {
    private readonly tables = new Map<string, Table>([
        ['AssistanceRequests', {key: 'Username', items: new Map()}],
        ['CallRecords', {key: 'Meeting', items: new Map()}],
        ['CommunicationUserIds', {key: 'Username', items: new Map()}],
        ['UserProfiles', {key: 'Username', items: new Map()}]
    ]);

    async send(command: DatabaseCommand): Promise<{
        Item?: DatabaseItem;
        Items?: DatabaseItem[];
        Attributes?: DatabaseItem;
    }> {
        const table = this.tables.get(command.input.TableName || '');
        if (!table) {throw new Error(`Unsupported local table: ${command.input.TableName}`);}

        if (command instanceof QueryCommand) {
            const input = command.input;
            const values = input.ExpressionAttributeValues;
            let items: DatabaseItem[];
            if (input.TableName === 'AssistanceRequests' && input.IndexName === 'DateTime'
                && input.KeyConditionExpression === '#pk = :pk'
                && input.ExpressionAttributeNames?.['#pk'] === 'PartitionKey') {
                items = [...table.items.values()]
                    .filter(item => item.PartitionKey?.S === values?.[':pk']?.S)
                    .sort((a, b) => a.DateTime.S!.localeCompare(b.DateTime.S!)
                        || a.Username.S!.localeCompare(b.Username.S!));
            } else if (input.TableName === 'UserProfiles' && input.IndexName === 'Email'
                && input.KeyConditionExpression === 'Email = :email') {
                items = [...table.items.values()].filter(item => item.Email?.S === values?.[':email']?.S);
            } else {
                throw new Error('Unsupported local query');
            }
            return {Items: structuredClone(items.slice(0, input.Limit))};
        }

        const record = command instanceof PutItemCommand ? command.input.Item : command.input.Key;
        const key = record?.[table.key]?.S;
        if (key === undefined) {throw new Error(`Missing local key: ${table.key}`);}
        const item = table.items.get(key);

        if (command instanceof GetItemCommand) {
            return {Item: structuredClone(item)};
        }
        if (command instanceof PutItemCommand) {
            if (command.input.ConditionExpression) {throw new Error('Unsupported local conditional put');}
            table.items.set(key, structuredClone(command.input.Item!));
            return {};
        }
        if (command instanceof DeleteItemCommand) {
            if (command.input.ConditionExpression) {throw new Error('Unsupported local conditional delete');}
            table.items.delete(key);
            return {Attributes: command.input.ReturnValues === 'ALL_OLD' ? structuredClone(item) : undefined};
        }
        if (command instanceof UpdateItemCommand) {
            const input = command.input;
            if (input.TableName !== 'CallRecords'
                || input.UpdateExpression !== 'SET EndDateTime = :endDateTime, Billable = :billable'
                || input.ConditionExpression !== 'attribute_exists(Meeting) AND Assistant = :assistant AND attribute_not_exists(EndDateTime)') {
                throw new Error('Unsupported local update');
            }
            const values = input.ExpressionAttributeValues!;
            if (!item || item.Assistant?.S !== values[':assistant'].S || item.EndDateTime) {
                const error = new Error('Open meeting not found');
                error.name = 'ConditionalCheckFailedException';
                throw error;
            }
            table.items.set(key, {...item, ...structuredClone({
                EndDateTime: values[':endDateTime'], Billable: values[':billable']
            })});
            return {};
        }
        throw new Error('Unsupported local database command');
    }
}
