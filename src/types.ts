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
 * A username associated with a CommunicationsUserIdentifier.
 */
export interface User extends CommunicationUserIdentifier {

    /**
     * The username of the user.
     */
    username: string;

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
