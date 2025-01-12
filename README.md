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

## Api

The following endpoints are available on the backend, once deployed.

### `GET /`

This endpoint will simply reply `{message: "Success"}`, it is intended to be used to check whether the api is online
and the credentials are valid.

### `POST /requestAssistance`

This is called by the end-user apps to add a new request to the queue. This will issue an access token for Azure 
Communication Services to the user that made the request (creating an identity for the user if none exists yet). It 
will then add the user's identity to the queue to be picked up by an assistant. If this is called twice using the 
same user account, the new request will replace the old one (the assumption here being that the user lost the 
connection and is retrying). This will return a user id and token to use to connect to ACS, along with the expiry 
time of the token, and an interval in seconds for how often to call the `/awaitAssistance`-endpoint to keep the 
request alive.

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
to respond. Which assistance request to update is automatically determined from the identity of the user account 
making the request. If the client fails to contact this endpoint, the request will time out and be removed by the 
backend. This is done to reduce the number of times an assistant will respond to a request, just to find that the 
user has lost the connection while waiting.

This will send a 200-response if the request was successfully updated. A 404-response will be returned if the 
request could not be found. The latter could mean that something has gone wrong, but it can also occur when an 
assistant has already accepted the assistance request and is in the process of establishing a connection. Because of 
this, clients should wait some time before giving up when they get a 404-response from this endpoint.

### `POST /cancelAssistance`

This can be called by the end-user apps to indicate to the backend that the user has given up on waiting for an 
assistant. The backend will then remove the assistance request for the user making the call from the list of open 
assistance requests.

This will return a 200-response if the request was successfully removed. It will return a 404-response if the 
assistance request could not be found.

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
