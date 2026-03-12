//
//  types.ts
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-11-24.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

import {CommunicationUserIdentifier} from '@azure/communication-common';
import {CommunicationAccessToken} from '@azure/communication-identity';

/** User profile information. */
export interface UserProfile {
    /** The user's first name. */
    firstName?: string;

    /** The user's last name. */
    lastName?: string;

    /** The user's email address. */
    email?: string;

    /** The user's gender. */
    gender?: string;

    /** The user's birthdate (ISO format: YYYY-MM-DD). */
    birthdate?: string;

    /** The user's phone number. */
    phone?: string;
}

/** A username associated with a CommunicationsUserIdentifier. */
export interface User extends CommunicationUserIdentifier {
    /** The username of the user. */
    username: string;

    /** Optional user profile information. */
    profile?: UserProfile;
}

/** A User associated with an access token. */
export interface UserToken extends CommunicationAccessToken {
    /** The User this UserToken is for. */
    user: User;
}

/** A User along with the Date the User requested assistance. */
export interface AssistanceRequest {
    /** The User requesting assistance. */
    user: User;

    /** The date and time at which the user requested the assistance. */
    startDateTime: Date;
}
