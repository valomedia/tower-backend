//
//  helpers.ts
//  tower-backend
//
//  Created by OpenClaw on 2026-06-10.
//

import type { UUID } from 'node:crypto';

type DynamoStringNumberAttributes = Record<string, { S?: string; N?: string } | undefined>;

export interface AssistanceRequestRecord {
    user: { username: string };
    startDateTime: Date;
}

export interface UserRecord {
    username: string;
    communicationUserId: string;
    firstName?: string;
    lastName?: string;
    gender?: string;
    birthdate?: string;
    phone?: string;
    email?: string;
}

export interface OpeningHoursConfig {
    hours?: string[][][];
    extraHours: string[][];
    holidays: string[];
}

export const assistanceRequestFromItem = (
    {
        Username,
        DateTime,
        TTL
    }: DynamoStringNumberAttributes
): AssistanceRequestRecord | undefined => {
    if (!Username?.S
        || !DateTime?.S
        || !TTL?.N
        || +TTL.N < Math.floor(Date.now() / 1000)
    ) {return;}
    return {
        user: {
            username: Username.S,
        },
        startDateTime: new Date(DateTime.S)
    };
};

export const userFromItem = (
    {
        Username,
        CommunicationUserId,
        FirstName,
        LastName,
        Gender,
        Birthdate,
        Phone,
        Email
    }: DynamoStringNumberAttributes
): UserRecord | undefined => {
    if (!Username?.S || !CommunicationUserId?.S) {return;}
    return {
        username: Username.S,
        communicationUserId: CommunicationUserId.S,
        firstName: FirstName?.S,
        lastName: LastName?.S,
        gender: Gender?.S,
        birthdate: Birthdate?.S,
        phone: Phone?.S,
        email: Email?.S
    };
};

/**
 * Check whether a string is a syntactically valid e-mail address.
 *
 * This is a deliberately loose check, intended only to reject obvious typos. It does not guarantee that the address
 * actually exists or accepts mail.
 *
 * @param email  The string to validate.
 *
 * @return true if the string looks like a valid e-mail address, false otherwise.
 */
export const isValidEmail = (email: string): boolean =>
    typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const request = ({body}: {body: string}): {[key: string]: any}|undefined => {
    try {
        const result = JSON.parse(body);
        return typeof result == 'object' ? result : undefined;
    } catch {
        return undefined;
    }
};

export const response = (statusCode: number, contentType: string, body: any, isBase64Encoded = false) => ({
    statusCode: statusCode,
    headers: {'Content-Type': contentType,},
    body: body,
    isBase64Encoded
});

/**
 * Calculate opening hours for a given date.
 *
 * @param date  The date to calculate the opening hours for, formatted as YYYY-MM-DD.
 * @param config  The regular hours, extra hours, and holidays to use for the calculation.
 *
 * @returns A list of time intervals, each specified by a tuple of a start and end Date.
 */
export const calculateOpeningHours = (date: string, {hours, extraHours, holidays}: OpeningHoursConfig): Date[][] => [
    !holidays.includes(date) && hours && hours[(new Date(date)).getUTCDay()].map(x => x.map(y => date + "T" + y)),
    extraHours.filter(([x]) => x.startsWith(date))
]
    .flat()
    .filter((x): x is string[] => !!x)
    .map(interval => interval.map(date => {
        const components = date.split(/[-T:]/);
        return new Date(+components[0], +components[1] - 1, +components[2], +components[3], +components[4])
    }));

export const isUUID = (uuid: any): uuid is UUID =>
    typeof uuid == 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){4}[0-9a-f]{8}$/i.test(uuid);

/**
 * Get the username for a given UUID.
 *
 * End users currently do not need to create an account. Instead, each device will register for a random UUID when the
 * user first uses the service. Since we normally have human-readable usernames, we need to map this UUID to the actual
 * username to be used internally. Currently, this is done by just prefixing the UUID with the string "user_".
 *
 * @param uuid The UUID to calculate the username for.
 *
 * @returns The username to use for the user with the given UUID.
 */
export const userIdToUsername = (uuid: UUID) => 'user_' + uuid.toLowerCase();
