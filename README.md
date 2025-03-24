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

During each deployment, a new temporary object will be created in an S3-bucket provided on the command line. The bucket
is not emptied automatically, so you might have to empty it manually every once in a while (or set a deletion rule), to
avoid unnecessary charges.

You can pass `-l`, or `--disable-printing-logs` to make the output of the deployment script less verbose.

## Configuration Options

Configuration options can be specified through environment variables, or in `.env.local`, `.env.local.development`,
`.env.local.production`, `.secrets`, `.secrets.development` and `.secrets.production`. Environment variables take
precedence over all configuration files, secrets take precedence over all env files, and environment-specific files 
take precedence over files that apply to both environments. The default values for the various configuration options can
also be found in `.env`, `.env.development` and `.env.production`.

### `AWS_REGION`

This is the AWS region the SAM-Stack and S3 bucket will be created in.

### `AWS_S3_BUCKET`

This is the name of a bucket that the application will be packaged in.  If the bucket doesn't exist, it will be 
automatically created.  During deployment, the source will be copied to a new object in this bucket, then deployed to
SAM from the bucket.  The object will no longer be needed afterward, but the bucket is not emptied automatically.

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

### `EXTRA_HOURS`

This is comma-separated list of time intervals, each formatted as YYYY-MM-DDThh:mm/hh:mm. The end time must be
after the start time (you can not have an interval that crosses midnight).

### `HOLIDAYS`

This is a comma-separated list of dates where the regular opening hours don't apply, each formatted as YYYY-MM-DD.

### `HOURS_DESCRIPTION`

This is a string describing the opening hours in a human-readable way.

### `TZ`

Timezone to use for opening hours.

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
