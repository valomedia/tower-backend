/*
 * Copyright (c) 2023-2026 valo.media GmbH
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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import https from 'https';
import {
    APIGatewayAuthorizerResult,
    APIGatewayTokenAuthorizerEvent,
    AuthResponse,
    Handler,
    StatementEffect
} from 'aws-lambda';
import { AzureKeyCredential } from '@azure/core-auth';
import { CommunicationIdentityClient } from '@azure/communication-identity';
import { createHandlers } from './application';
import * as fs from 'node:fs';

const ddb = new DynamoDBClient({ region: process.env.AWS_REGION! });
const s3 = new S3Client({ region: process.env.AWS_REGION! });
const ses = new SESv2Client({ region: process.env.AWS_REGION! });

// Read environment.
const assistanceRequestsTableName = process.env.ASSISTANCE_REQUESTS_TABLE_NAME!;
const callRecordsTableName = process.env.CALL_RECORDS_TABLE_NAME!;
const communicationUserIdsTableName = process.env.COMMUNICATION_USER_IDS_TABLE_NAME!;
const userProfilesTableName = process.env.USER_PROFILES_TABLE_NAME!;
const authUrl = process.env.AUTH_URL!;
const communicationServicesEndpoint = process.env.COMMUNICATION_SERVICES_ENDPOINT!;
const communicationServicesAccesskey = process.env.COMMUNICATION_SERVICES_ACCESSKEY!;
const mailFromAddress = process.env.MAIL_FROM_ADDRESS;
const hours = process.env.HOURS
    ? process.env.HOURS.split(":").map(intervals => intervals
        .split(",")
        .filter(Boolean)
        .map(interval => interval.split("/").map(time => time.slice(0, 2) + ":" + time.slice(-2)))
    )
    : undefined;
const extraHours = process.env.EXTRA_HOURS!.split(",").filter(Boolean).map(interval => {
    const [date, startTime, endTime] = interval.split(/[/T]/);
    return [date + "T" + startTime, date + "T" + endTime];
});
const holidays = process.env.HOLIDAYS!.split(",").filter(Boolean);
const hoursDescription = process.env.HOURS_DESCRIPTION!;
const uploadBucket = process.env.UPLOAD_BUCKET!;
const sourceUrl = process.env.SOURCE_URL!;

const communicationIdentityClient = new CommunicationIdentityClient(
    communicationServicesEndpoint,
    new AzureKeyCredential(communicationServicesAccesskey)
);

/**
 * Send a confirmation e-mail to a user who has just added or changed their e-mail address.
 *
 * If no from-address is configured, sending is silently skipped (allowing deployments to opt out of e-mail entirely).
 * Otherwise, any failure from SES is propagated to the caller, so the calling handler can decide how to surface it.
 *
 * @param recipient  The address to send the confirmation to.
 */
const sendEmailConfirmation = async (recipient: string): Promise<void> => {
    if (!mailFromAddress) {
        console.warn('MAIL_FROM_ADDRESS is not configured; skipping confirmation e-mail');
        return;
    }
    await ses.send(new SendEmailCommand({
        FromEmailAddress: mailFromAddress,
        Destination: { ToAddresses: [recipient] },
        Content: {
            Simple: {
                Subject: { Data: 'Deine E-Mail-Adresse wurde verknüpft', Charset: 'UTF-8' },
                Body: {
                    Text: {
                        Data:
                            'Hallo,\n\n' +
                            'deine E-Mail-Adresse wurde mit einem Tower-Profil verknüpft.\n\n' +
                            'Falls du das nicht warst, melde dich bitte unter webmaster@tower-assist.de.\n\n' +
                            'Viele Grüße\n' +
                            'Dein Tower-Team\n',
                        Charset: 'UTF-8'
                    }
                }
            }
        }
    }));
};

export const {
    indexHandler,
    registerUserHandler,
    requestAssistanceHandler,
    awaitAssistanceHandler,
    cancelAssistanceHandler,
    assistanceTokenHandler,
    offerAssistanceHandler,
    beginAssistanceHandler,
    endAssistanceHandler,
    createImageUploadUrlHandler,
    createImageDownloadUrlHandler,
    getUserHandler,
    updateUserHandler,
} = createHandlers({
    assistanceRequestsTableName, callRecordsTableName, communicationUserIdsTableName, userProfilesTableName,
    hours, extraHours, holidays, hoursDescription, sourceUrl,
    backendVersion: JSON.parse(fs.readFileSync('package.json', 'utf-8')).version
}, {
    ddb,
    communicationIdentityClient,
    sendEmailConfirmation,
    getImageUrl: (method, key, expiresIn) => getSignedUrl(s3, method === 'PUT'
        ? new PutObjectCommand({Bucket: uploadBucket, Key: key, ContentType: 'image/jpeg'})
        : new GetObjectCommand({Bucket: uploadBucket, Key: key}), {expiresIn})
});

// noinspection JSUnusedGlobalSymbols
/**
 * Authorize the request based on basic authentication.
 *
 * This will throw a request's authorization token against the auth url, authorizing the request, if the response has a
 * HTTP status code of 200.
 *
 * @param event     The event object containing the authorization token from the request.
 */
export const authHandler: Handler = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
    const token = event.authorizationToken;
    const principalId = Buffer.from(token.split(' ')[1], 'base64').toString('utf-8').split(':')[0];

    return new Promise((resolve, reject) =>
        https
            .request(
                authUrl,
                {
                    method: 'HEAD',
                    headers: { authorization: token }
                },
                (res) => {
                    if (res.statusCode === 200) {
                        resolve(generatePolicy(principalId, 'Allow'));
                    } else {
                        reject("Unauthorized");
                    }
                }
            )
            .on('error', (_) => {
                console.error('Failed to reach authentication server!');
                reject("Unauthorized");
            })
            .end()
    );
};

/**
 * Helper function to generate an IAM policy.
 *
 * This is used by the lambda token authorizer to authorize the user.
 *
 * @param principalId   The string used in the principalId field of the AuthResponse.
 * @param effect        The StatementEffect to me effected by the new PolicyDocument.
 *
 * @returns An AuthResponse with a single statement that applies the desired effect to any execute-api:Invoke-Action.
 */
const generatePolicy = (principalId: string, effect: StatementEffect): AuthResponse => ({
    principalId,
    policyDocument: {
        Version: '2012-10-17',
        Statement: [
            {
                Action: 'execute-api:Invoke',
                Effect: effect,
                Resource: '*'
            }
        ]
    }
});
