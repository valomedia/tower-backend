# Tower Backend

AWS SAM backend for Tower.

## Usage

To deploy the service, configure the environment variables and execute the deploy-script.

### Configuration

To configure the service, you will need to at a minimum supply values for the environment variables `AUTH_URL`,
`AZ_COMMUNICATION_SERVICES_ENDPOINT`, and `AZ_COMMUNICATION_SERVICES_ACCESSKEY` (documented below). For the former two 
you will normally want to create a file called `.env.development.local` or `.env.production.local` (depending on which
environment you want to deploy), the latter should go into `.secrets.development` or `.secrets.production` instead.
These files should be in env file format. To update an existing deployment, make sure to specify the same values as the
ones supplied during the initial deployment for `AWS_REGION`, `AWS_CLOUDFORMATION_STACK` and `AWS_SAM_STAGE_NAME`.

### Building

Use `npm run build` to build the project, and `npm run clean` to clean the build folder. This isn't normally needed, as
the project will be built automatically by the deploy-script.

### Deployment

Use `npm run deploy` to deploy the development configuration, and `npm run deploy -- --env production` to deploy the
production configuration (aws-cli needs to be installed and logged in). All AWS resources will be created automatically. 
When the script finishes, it outputs the url to the newly deployed backend, which can be used as is, or assigned to a
custom domain using the AWS API Gateway Console.

During each deployment, a new temporary object will be created in an S3-bucket provided using the `AWS_S3_BUCKET` 
configuration option. This object contains the packaged application. It is not needed during runtime and can be 
deleted after the application deployment has finished. However, it can be useful to have old packages, since it 
makes it easier to roll back changes. For this reason, the bucket is not emptied automatically. You might want to 
empty it manually every once in a while (or set a deletion rule), to avoid unnecessary charges. This only applies to 
the bucket used for deployment (the one provided by name in the configuration options). Any buckets the application 
needs at runtime will be created with randomized names and their contents will be cleaned up automatically.

You can pass `-l`, or `--disable-printing-logs` to make the output of the deployment script less verbose.

## Configuration Options

Configuration options can be specified through environment variables, or in `.env.local`, `.env.local.development`,
`.env.local.production`, `.secrets`, `.secrets.development` and `.secrets.production`. Environment variables take
precedence over all configuration files, secrets take precedence over all env files, and environment-specific files 
take precedence over files that apply to both environments. The default values for the various configuration options can
also be found in `.env`, `.env.development` and `.env.production`.

### `AWS_REGION`

This is the AWS region the application will be deployed to.

### `AWS_S3_BUCKET`

This is the name of a bucket that the application will be packaged in. If the bucket doesn't exist, it will be 
automatically created. During deployment, the source will be copied to a new object in this bucket, then deployed to
SAM from the bucket. The object will no longer be needed afterward, but the bucket is not emptied automatically to 
allow for rollbacks to previously deployed versions when something goes wrong. This configuration option only 
configures which bucket is used for deployment, it does not affect any buckets used by the application at runtime, 
whose names will be chosen automatically and have a randomized suffix for uniqueness.

### `AWS_CLOUDFORMATION_STACK`

This is the name for the CloudFormation stack to deploy the backend in. If the stack does not exist yet, it will be 
created during deployment.

### `AWS_SAM_STAGE_NAME`

This is the stage name for the AWS SAM API. The stage name doesn't really matter, since there will always be exactly one
stage in the stack. However, it is still useful to use a name that matches the purpose of the deployment (such as `Dev`,
`Staging`, or `Prod`), to prevent confusion when assigning gateways to the various APIs down the road.

### `AUTH_URL`

Any url that the backend can GET and that checks the authorization header and answers `200 OK` if the user should be
authorized and `401 UNAUTHORIZED` if the user should not be authorized. The backend will make a GET-request to this
endpoint, providing the user's authorization-header. If the endpoint answers `200 OK`, the user will be authorized and
the authorization will be cached for 5 minutes.

### `ALLOW_ORIGIN`

This is the content for the HTTP-header Access-Control-Allow-Origin. It is used verbatim. If you want to make
cross-origin requests from tower-staff, this needs to be the origin the tower-staff application is making the requests
from.

### `AZ_COMMUNICATION_SERVICES_ENDPOINT`

The endpoint to use to connect to Azure Communication Services.

### `AZ_COMMUNICATION_SERVICES_ACCESSKEY`

The access key to use to connect to Azure Communication Services.

### `HOURS`

The regular opening hours for each day of the week, starting with Sunday. Days are separated by a colon character and
multiple time intervals for the same day are separated by a comma. Each time interval is specified by a start and end
time, each formatted as hhmm, separated by a slash.

If this is used, it must contain exactly six colon characters (as field-separators between the seven days). If this 
is left empty, it will turn the whole opening hours system off (always showing as open, but without a schedule). To 
specify `EXTRA_HOURS` without any regular hours, set `HOURS` to `::::::`.

### `EXTRA_HOURS`

This is comma-separated list of time intervals, each formatted as YYYY-MM-DDThh:mm/hh:mm. The end time must be
after the start time (you can not have an interval that crosses midnight). This is ignored if `HOURS` is unset.

### `HOLIDAYS`

This is a comma-separated list of dates where the regular opening hours don't apply, each formatted as YYYY-MM-DD. 
This is ignored if `HOURS` is unset.

### `HOURS_DESCRIPTION`

This is a string describing the opening hours in a human-readable way. This is ignored if `HOURS` is unset.

### `TZ`

Timezone to use for opening hours. If this is unset, the server's timezone will be used.

## Api

The following endpoints are available on the backend, once deployed.

### `GET /`

This endpoint will return some general information about the service. It can be used to ensure the api is online and 
has a compatible version, and to check the opening hours. It will return a `message`, which is currently always 
`"Success"`, along with an `apiVersion`-string containing the major and minor version of the backend, and an 
`openingHours`-object. The latter will give the current `time` (as hh:mm) in the time zone the service operates in, a 
`status`, indicating whether the service is currently `"open"` or `"closed"`, a `description` with a human-readable 
version of the opening hours, and a `schedule` for the next few days. The `schedule` is intended to be both 
human-readable and machine parseable and will take things like holidays and special opening hours into account.

Response format:

```
{
    message: "Success",
    apiVersion: string,
    openingHours: {
        time: string,
        status: "open"|"closed",
        schedule: {[key: string]: string},
        description: string
    }
}
```

Example response:

```json
{
    "message": "Success",
    "apiVersion": "1.0",
    "openingHours": {
        "time": "13:37",
        "status": "closed",
        "schedule": {
            "2025-02-14": "08:00-12:00, 13:00-17:00",
            "2025-02-15": "",
            "2025-02-16": "",
            "2025-02-17": "",
            "2025-02-18": "12:00-16:00",
            "2025-02-19": "12:00-16:00",
            "2025-02-20": "12:00-16:00",
            "2025-02-21": ""
        },
        "description": "Montag bis Freitag von 8 bis 12 und von 13 bis 17 Uhr."
    }
}
```

### `POST /registerUser`

This is called by the end-user apps when the user first opens them. The endpoint will create an identity for the 
user with a random UUID. It will return the UUID to the client, which the client will then pass along in all further 
requests to the backend. Since the UUID can be used without further authentication and can be used to retrieve some 
information about the user (such as when and for how long the user has called), it should be treated as moderately 
sensitive.

Optionally, profile information can be provided during registration. If an email is provided, it must be unique across
all users. All profile fields are optional and can also be set or updated later via the `/updateUser` endpoint.

Request format:

```
{
    firstName?: string,
    lastName?: string,
    email?: string,
    gender?: string,
    birthdate?: string (YYYY-MM-DD format),
    phone?: string
}
```

Example request (without profile):

```json
{}
```

Example request (with profile):

```json
{
    "firstName": "Anna",
    "lastName": "Müller",
    "email": "anna.mueller@example.com",
    "gender": "female",
    "birthdate": "1990-05-15",
    "phone": "+49123456789"
}
```

Response format:

```
{
    userId: UUID
}
```

Example response:

```json
{
    "userId":"908d4e54-18cd-41f1-80fc-57779a108947"
} 
```

Error responses:

- `400 Bad Request` - If validation fails (invalid email format, birthdate not in YYYY-MM-DD format, etc.)
- `400 Bad Request` - If the provided email is already registered by another user

### `POST /requestAssistance`

This is called by the end-user apps to add a new request to the queue. This will issue an access token for Azure 
Communication Services to the user whose ID is specified in the request. It will then add the user's identity to 
the queue to be picked up by an assistant. If this is called twice using the same user id, the new request will 
replace the old one (the assumption here being that the user lost the connection and is retrying). This will return 
an ACS user id and token to use to connect to ACS, along with the expiry time of the token, and an interval in 
seconds for how often to call the `/awaitAssistance`-endpoint to keep the request alive.

Request format:

```
{
    userId: UUID
}
```

Example request:

```json
{
    "userId":"908d4e54-18cd-41f1-80fc-57779a108947"
} 
```

Response format:

```
{
    userToken: {
        user: {username: string, communicationUserId: string},
        token: string,
        expiresOn: string
    },
    keepaliveInterval: number
}
```

Example response:

```json
{
    "userToken": {
        "user": {
          "username": "theo.test",
          "communicationUserId": "8:acs:86423206-6599-4274-a6c6-3f9108a2ab41_00000024-04d3-a94b-59fe-ad3a0d00e963"
        },
        "token": "…",
        "expiresOn": "2025-01-08T20:55:05.176Z"
    },
    "keepaliveInterval": 10
}
```

### `POST /awaitAssistance`

This is called repeatedly by the end-user apps to keep the assistance request active while waiting for an assistant 
to respond. If the client fails to contact this endpoint, the request will time out and be removed by the backend. 
This is done to reduce the number of times an assistant will respond to a request, just to find that the user has 
lost the connection while waiting.

The client specifies the id of the user who is waiting to be assisted in the request. Since there can only be one 
assistance request per user at any given time, this is sufficient to determine the assistance request to update.

The endpoint will send a 200-response if the request was successfully updated. A 404-response will be returned if the 
request could not be found. The latter could mean that something has gone wrong, but it can also occur when an 
assistant has already accepted the assistance request and is in the process of establishing a connection. Because of 
this, clients should wait some time before giving up when they get a 404-response from this endpoint.

In a 200-response, the backend will include the position of the user in the queue of assistance requests waiting to be
picked up. This position is zero-indexed. This means that it is equal to the number of waiting users that will be 
served ahead of the user making the request. This value just reflects the number of users waiting to be assisted. 
Ongoing calls are not included in the count.

Request format:

```
{
    userId: UUID
}
```

Example request:

```json
{
    "userId":"908d4e54-18cd-41f1-80fc-57779a108947"
} 
```

Response format:

```
{
    position: number
}
```

Example response:

```json
{
    "position": 0
}
```

### `POST /cancelAssistance`

This can be called by the end-user apps to indicate to the backend that the user has given up on waiting for an 
assistant. The backend will then remove the assistance request for the user making the call from the list of open 
assistance requests.

The client specifies the id of the user who no longer wants to be assisted in the request. Since there can only be one
assistance request per user at any given time, this is sufficient to determine the assistance request to remove.

This will return a 200-response if the request was successfully removed. It will return a 404-response if the 
assistance request could not be found.

Request format:

```
{
    userId: UUID
}
```

Example request:

```json
{
    "userId":"908d4e54-18cd-41f1-80fc-57779a108947"
} 
```

### `POST /getUser`

This endpoint retrieves an existing user's profile information. For now, no authentication is required - anyone with
the userId can retrieve the profile.

Request format:

```
{
    userId: UUID
}
```

Example request:

```json
{
    "userId": "908d4e54-18cd-41f1-80fc-57779a108947"
}
```

Response format:

```
{
    user: {
        username: string,
        communicationUserId: string,
        firstName?: string,
        lastName?: string,
        email?: string,
        gender?: string,
        birthdate?: string,
        phone?: string
    }
}
```

Example response:

```json
{
    "user": {
        "username": "user_908d4e54-18cd-41f1-80fc-57779a108947",
        "communicationUserId": "8:acs:86423206-6599-4274-a6c6-3f9108a2ab41_00000024-04d3-a94b-59fe-ad3a0d00e963",
        "firstName": "Anna",
        "lastName": "Müller",
        "email": "anna.mueller@example.com",
        "gender": "female",
        "birthdate": "1990-05-15",
        "phone": "+49123456789"
    }
}
```

Error responses:

- `400 Bad Request` - If userId parameter is missing
- `404 Not Found` - If the user with the provided userId does not exist

### `POST /updateUser`

This endpoint allows updating an existing user's profile information. For now, no authentication is required - anyone
with the userId can update the profile. The user must already exist (have been registered via the `/registerUser`
endpoint).

All profile fields are optional. Only the fields provided in the request will be updated; omitted fields will remain
unchanged. If an email is provided, it must not be already registered by another user.

Profile field validation rules:
- `firstName`: 1-100 characters if provided
- `lastName`: 1-100 characters if provided
- `email`: Must be a valid email format (will be normalized to lowercase)
- `gender`: Maximum 50 characters if provided
- `birthdate`: Must be in YYYY-MM-DD format if provided
- `phone`: 10-20 characters if provided

Request format:

```
{
    userId: UUID,
    firstName?: string,
    lastName?: string,
    email?: string,
    gender?: string,
    birthdate?: string (YYYY-MM-DD format),
    phone?: string
}
```

Example request:

```json
{
    "userId": "908d4e54-18cd-41f1-80fc-57779a108947",
    "firstName": "Anna",
    "lastName": "Müller",
    "email": "anna.mueller@example.com",
    "phone": "+49123456789"
}
```

Response format:

```
{}
```

Example response:

```json
{}
```

Error responses:

- `400 Bad Request` - If userId parameter is missing
- `400 Bad Request` - If validation fails (invalid email format, name too long, etc.)
- `400 Bad Request` - If the provided email is already registered by another user
- `404 Not Found` - If the user with the provided userId does not exist

### `GET /assistanceToken`

This will mint an ACS access token for the assistant making the request. The token will be valid for 24 hours and is 
meant to be reused across calls.

Response format:

```
{
    userToken: {
        user: {username: string, communicationUserId: string},
        token: string,
        expiresOn: string
    },
}
```

Example response:

```json
{
    "userToken": {
        "user": {
          "username": "michael.assistent",
          "communicationUserId": "8:acs:86423206-6599-4274-a6c6-3f9108a2ab41_00000023-ffe3-3212-f4f3-ad3a0d00457f"
        },
        "token": "…",
        "expiresOn": "2025-01-09T19:17:39.743Z"
    }
}
```

### `GET /offerAssistance`

This will check for open assistance requests and return the oldest one, if any. If there aren't any open assistance 
requests, the response will be a 200-response, with an empty object in its body. This allows for checking if there 
is an assistance request to be answered, so the incoming request can be shown to the assistants.

Response format:

```
{
    assistanceRequest: {
        user: {username: string, communicationUserId: string},
        startDateTime: string
    }
}
```

Example response:

```json
{
    "assistanceRequest": {
        "user": {
            "username": "theo.test",
            "communicationUserId": "8:acs:86423206-6599-4274-a6c6-3f9108a2ab41_00000024-04d3-a94b-59fe-ad3a0d00e963"
        },
        "startDateTime": "2025-01-08T19:27:59.759Z"
    }
}
```

### `POST /beginAssistance`

This will remove the oldest assistance request from the queue and return it. If there aren't any open assistance 
requests, this endpoint will respond with a 404-response.

Response format:

```
{
    assistanceRequest: {
        user: {username: string, communicationUserId: string},
        startDateTime: string
    }
}
```

Example response:

```json
{
    "assistanceRequest": {
        "user": {
            "username": "theo.test",
            "communicationUserId": "8:acs:86423206-6599-4274-a6c6-3f9108a2ab41_00000024-04d3-a94b-59fe-ad3a0d00e963"
        },
        "startDateTime": "2025-01-08T19:27:59.759Z"
    }
}
```

### `POST /createImageUploadUrl`

This will create a single-use URL the customer's app can use to upload an image to an S3-bucket. To prevent abuse, there 
isn't an endpoint the end-user apps can use to freely upload data. Instead, when the assistant wants to take a photo,
the app of the assistant will use this endpoint to generate an upload link that is only valid once.This upload link 
is then provided to user's app, so it can upload the photo.The endpoint will return the `uploadURL`, along with a `key`
that can be used to get a download url for the ressource later and the date the upload URL `expiresOn`.

Response format:

```
{
    uploadUrl: string,
    key: string,
    expiresOn: string
}
```

Example response:

```json
{
    "uploadUrl": "…",
    "key": "25058120.jpeg",
    "expiresOn": "2025-05-04T16:55:51.962Z"
}
```

### `POST /createImageDownloadUrl`

This will create a URL the app of the assistant can use to access the photo uploaded by a user. For this, the `key` 
returned by the `/createImageUploadUrl`-endpoint needs to be provided. The endpoint will return the `downloadUrl`, 
along with the date the download URL `expiresOn`.

Request format:

```
{
    key: string
}
```

Example request:

```json
{
    "key": "25058120.jpeg"
}
```

Response format:

```
{
    downloadUrl: string,
    expiresOn: string
}
```

Example response:

```json
{
    "downloadUrl": "…",
    "expiresOn": "2025-05-04T18:50:53.927Z"
}
```
