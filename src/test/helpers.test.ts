//
//  helpers.test.ts
//  tower-backend
//
//  Created by OpenClaw on 2026-06-10.
//

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assistanceRequestFromItem,
    calculateOpeningHours,
    isUUID,
    isValidEmail,
    request,
    response,
    userFromItem,
    userIdToUsername
} from '../helpers';

test('request parses JSON object bodies and ignores invalid bodies', () => {
    assert.deepEqual(request({body: '{"userId":"abc"}'}), {userId: 'abc'});
    assert.equal(request({body: '"not an object"'}), undefined);
    assert.equal(request({body: 'not json'}), undefined);
});

test('response builds API Gateway proxy responses', () => {
    assert.deepEqual(response(201, 'application/json', '{"ok":true}'), {
        statusCode: 201,
        headers: {'Content-Type': 'application/json'},
        body: '{"ok":true}',
        isBase64Encoded: false
    });
});

test('isUUID accepts canonical UUIDs and rejects malformed values', () => {
    assert.equal(isUUID('550e8400-e29b-41d4-a716-446655440000'), true);
    assert.equal(isUUID('550E8400-E29B-41D4-A716-446655440000'), true);
    assert.equal(isUUID('550e8400e29b41d4a716446655440000'), false);
    assert.equal(isUUID(undefined), false);
});

test('userIdToUsername prefixes and lowercases UUIDs', () => {
    assert.equal(
        userIdToUsername('550E8400-E29B-41D4-A716-446655440000'),
        'user_550e8400-e29b-41d4-a716-446655440000'
    );
});

test('isValidEmail catches obvious email typos', () => {
    assert.equal(isValidEmail('person@example.org'), true);
    assert.equal(isValidEmail('person.name+tag@example.co.uk'), true);
    assert.equal(isValidEmail('missing-at.example.org'), false);
    assert.equal(isValidEmail('person@example'), false);
    assert.equal(isValidEmail('person @example.org'), false);
});

test('assistanceRequestFromItem maps unexpired DynamoDB items', () => {
    const startDateTime = '2026-06-10T12:34:56.000Z';
    const result = assistanceRequestFromItem({
        Username: {S: 'user_123'},
        DateTime: {S: startDateTime},
        TTL: {N: `${Math.floor(Date.now() / 1000) + 60}`}
    });

    assert.deepEqual(result, {
        user: {username: 'user_123'},
        startDateTime: new Date(startDateTime)
    });
});

test('assistanceRequestFromItem ignores expired or incomplete DynamoDB items', () => {
    assert.equal(assistanceRequestFromItem({
        Username: {S: 'user_123'},
        DateTime: {S: '2026-06-10T12:34:56.000Z'},
        TTL: {N: `${Math.floor(Date.now() / 1000) - 1}`}
    }), undefined);
    assert.equal(assistanceRequestFromItem({Username: {S: 'user_123'}}), undefined);
});

test('userFromItem maps DynamoDB user records', () => {
    assert.deepEqual(userFromItem({
        Username: {S: 'user_123'},
        CommunicationUserId: {S: 'acs-user'},
        FirstName: {S: 'Ada'},
        LastName: {S: 'Lovelace'},
        Gender: {S: 'female'},
        Birthdate: {S: '1815-12-10'},
        Phone: {S: '+49123456789'},
        Email: {S: 'ada@example.org'}
    }), {
        username: 'user_123',
        communicationUserId: 'acs-user',
        firstName: 'Ada',
        lastName: 'Lovelace',
        gender: 'female',
        birthdate: '1815-12-10',
        phone: '+49123456789',
        email: 'ada@example.org'
    });
    assert.equal(userFromItem({Username: {S: 'user_123'}}), undefined);
});

test('calculateOpeningHours combines regular and extra hours for a date', () => {
    const hours = [
        [],
        [],
        [],
        [['08:00', '12:00'], ['13:00', '17:00']],
        [],
        [],
        []
    ];

    const result = calculateOpeningHours('2026-06-10', {
        hours,
        extraHours: [['2026-06-10T18:00', '2026-06-10T19:30'], ['2026-06-11T09:00', '2026-06-11T10:00']],
        holidays: []
    });

    assert.deepEqual(result.map(interval => interval.map(date => [date.getHours(), date.getMinutes()])), [
        [[8, 0], [12, 0]],
        [[13, 0], [17, 0]],
        [[18, 0], [19, 30]]
    ]);
});

test('calculateOpeningHours suppresses regular hours on holidays but keeps extra hours', () => {
    const hours = [
        [],
        [],
        [],
        [['08:00', '12:00']],
        [],
        [],
        []
    ];

    const result = calculateOpeningHours('2026-06-10', {
        hours,
        extraHours: [['2026-06-10T18:00', '2026-06-10T19:00']],
        holidays: ['2026-06-10']
    });

    assert.deepEqual(result.map(interval => interval.map(date => [date.getHours(), date.getMinutes()])), [
        [[18, 0], [19, 0]]
    ]);
});
