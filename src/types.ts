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
