//
//  types.ts
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-11-24.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

import { CommunicationUserIdentifier } from '@azure/communication-common';
import { CommunicationAccessToken } from '@azure/communication-identity';

/**
 * A user associated with a CommunicationsUserIdentifier.
 */
export interface User extends CommunicationUserIdentifier {

    /**
     * The username of the user.
     */
    username: string;

    // 2026-04-14 - DH - added user profile fields
    /**
     * The given name of the user, if known.
     */
    firstName?: string;

    /**
     * The family name of the user, if known.
     */
    lastName?: string;

    /**
     * The gender of the user, if known.
     */
    gender?: string;

    /**
     * The birthdate of the user (formatted as YYYY-MM-DD), if known.
     */
    birthdate?: string;

    /**
     * The preferred phone number for calling the user, if known.
     */
    phone?: string;

    /**
     * The preferred e-mail address for contacting the user, if known.
     */
    email?: string;

}

/**
 * A User associated with an access token.
 */
export interface UserToken extends CommunicationAccessToken {

    /**
     * The User this UserToken is for.
     */
    user: User;

}

/**
 * A User along with the Date the User requested assistance.
 */
export interface AssistanceRequest {

    /**
     * The User requesting assistance.
     */
    user: User;

    /**
     * The date and time at which the user requested the assistance.
     */
    startDateTime: Date;

}
