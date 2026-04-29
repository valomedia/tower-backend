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
 * Profile information for a user
 */
export interface UserProfile {

    /**
     * The username of the user.
     */
    username: string;

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
 * A user associated with a CommunicationsUserIdentifier.
 */
export interface User extends CommunicationUserIdentifier, UserProfile {}

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
     *
     * This isn't always a fully populated user-object to save database requests.
     */
    user: {username: string};

    /**
     * The date and time at which the user requested the assistance.
     */
    startDateTime: Date;

}
