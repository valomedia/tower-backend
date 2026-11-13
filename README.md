# Tower Backend

AWS SAM backend for Tower.

## Local development

Use Node.js 22.13+ (Node 24 is provided by the devcontainer) and npm.
No Docker daemon, cloud account, credentials, or assistant account setup is needed for the local server.

```sh
npm ci
npm run dev
```

The server listens on `http://127.0.0.1:3001`.
The command installs the Lambda development dependencies and compiles the local entry point into `build-local/`.
Stop with Ctrl+C and rerun after source changes;
every launch starts with an empty in-memory database and image store.
It reuses the deployed API handlers, including profile validation, queue expiry, and meeting ownership checks.

Protected endpoints still require a syntactically valid Basic authorization header,
but **any username and password are accepted**.
The username identifies the assistant for call records;
passwords are not checked or stored.
For example:

```sh
curl http://127.0.0.1:3001/
curl -u anyone:anything http://127.0.0.1:3001/assistanceToken
curl -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3001/registerUser
```

ACS identities and tokens are fake and cannot authorize real calls.
Queue and call-record flows can be tested through the API,
but media calls, data channels, and ACS SDK initialization are not supported.
A frontend using the real ACS SDK may reject these tokens or attempt to contact ACS;
mock its calling stack separately when testing those screens offline.
No confirmation emails are sent.
Image URL endpoints return temporary local links supporting JPEG uploads and downloads,
with a 10 MiB request limit and single-use upload links.
All backend service dependencies are local;
the server does not load deployment `.env` or `.secrets` files or use cloud credentials from the shell.

Local-only environment options:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_PORT` | `3001` | HTTP listening port. |
| `LOCAL_HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` only when explicitly needed for container access. |
| `LOCAL_ORIGIN` | `http://localhost:3000` | Allowed browser origin for credentialed CORS requests. |
| `LOCAL_PUBLIC_URL` | `http://127.0.0.1:<LOCAL_PORT>` | Browser-reachable origin for image links, if forwarding changes the hostname or port. |
| `LOCAL_PROXY_ORIGIN` | Unset | Additional trusted frontend proxy target origin, when its Host/Origin headers differ from the public URL. |

For Tower Staff, set `TOWER_PROXY_TARGET=http://127.0.0.1:3001` when starting its development server.
When the frontend runs in another container, use a reachable backend address instead.
For example, with a proxy target of `http://tower-backend:3001`,
set `LOCAL_HOST=0.0.0.0` and `LOCAL_PROXY_ORIGIN=http://tower-backend:3001` on the backend,
and set `LOCAL_PUBLIC_URL` to the browser-reachable origin for image links.
Only explicitly configured origins and local hostnames are accepted.
Never expose this unauthenticated development service to an untrusted network
or make its forwarded port public.
Production builds do not include the local entry point or its mocks.

### Optional Docker-in-Docker devcontainer

The standard `.devcontainer/devcontainer.json` is unchanged and does not enable Docker-in-Docker.
To opt in, select `.devcontainer/docker/devcontainer.json`
when opening/rebuilding the repository in a devcontainer
(in VS Code, use **Dev Containers: Reopen in Container** and select the Docker configuration).
It reuses the existing Node/SAM image,
adds the Docker-in-Docker feature,
and forwards port 3001.
Run `npm run dev` inside the container;
no server is started automatically.

**Docker-in-Docker requires a privileged container and weakens container isolation.**
Use this configuration only with a trusted repository on a suitable development host.
The local server itself does not require Docker;
this alternative is for workflows that also need nested containers.
The configuration is covered by static checks;
actual privileged-container startup must be verified on a Docker-capable host.

## Usage

To deploy the service, configure the environment variables and execute the deploy-script.

### Prerequisites

For this service to work, you need to deploy Azure Communication Services to handle the actual calls, as well as a 
system that handles authentication. The correct endpoints for both of these things are then passed as configuration 
parameters to your actual deployment.

For Instructions on how to create an Azure Communication Services resource, please have a look at the official
[docs](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/create-communication-resource). If 
it is legally possible for you to collect this data, you will probably also want to deploy a Log Analytics Workspace and 
connect it with the Communication Service to give you insight into the calls. For details see the documentation on how
to [enable logging](https://learn.microsoft.com/en-us/azure/communication-services/concepts/analytics/enable-logging)
for Azure Communication services.

For the authentication, you will need a webserver with an endpoint the backend can call to check if a user should be 
authorized. The backend will call this endpoint for each user, providing the credentials through HTTP basic auth. If 
the user should be authorized, the authentication server should answer `200 OK`. If the credentials are incorrect, 
the server should usually answer `401 Unauthorized`.

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
When the script finishes, it outputs the url to the newly deployed backend.

The backend can be used as is, but you will probably want to assign it a custom domain. To do this, first add a 
certificate for the domain you want to use in AWS Certificate Manager. Most of the time you will want an 
edge-optimized domain (meaning that CloudFront will serve requests through whichever datacenter is topologically closest
to the user). For this to work, you need to generate the certificate in `us-east-1`. If you create it in any other 
region, you won't be able to select it when creating your domain. Once you have a certificate, you can add the 
custom domain name to Amazon API Gateway, update your DNS-records to point to Amazon, and configure an API mapping 
to map the domain name to the tower-backend API.

During each deployment, a new temporary object will be created in an S3-bucket provided using the `AWS_S3_BUCKET` 
configuration option. This object contains the packaged application. It is unnecessary during runtime and can be 
deleted after the application deployment has finished. However, it can be useful to have old packages since it 
makes it easier to roll back changes. For this reason, the bucket is not emptied automatically. You might want to 
empty it manually every once in a while (or set a deletion rule) to avoid unnecessary charges. This only applies to 
the bucket used for deployment (the one provided by name in the configuration options). Any buckets the application 
needs at runtime will be created with randomized names, and their contents will be cleaned up automatically.

You can pass `-l`, or `--disable-printing-logs` to make the output of the deployment script less verbose.

### Destruction

To completely remove an instance of the service, remove the following:

* Azure Communication Service (and the associated Log Analytics Workspace if you have one)
* The AWS SAM application
* The upload bucket
* If applicable the custom domain along with its certificate

## Configuration Options

Configuration options can be specified through environment variables, or in `.env.local`, `.env.local.development`,
`.env.local.production`, `.secrets`, `.secrets.development` and `.secrets.production`. Environment variables take
precedence over all configuration files, secrets take precedence over all env files, and environment-specific files 
take precedence over files that apply to both environments. The default values for the various configuration options can
also be found in `.env`, `.env.development` and `.env.production`.

### `AWS_REGION`

This is the AWS region the application will be deployed to.

### `AWS_PROFILE`

This is the name of the AWS named profile to use for deployment. When set, it is passed to the `aws` and `sam` CLIs via
`--profile`, so you can deploy into a different AWS account without changing the active profile in your shell. Leave it
empty (the default) to use the CLIs' default credential resolution.

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

The regular opening hours for each day of the week, starting with Sunday. Days are separated by a colon character, and
multiple time intervals for the same day are separated by a comma. Each time interval is specified by a start and end
time, each formatted as hhmm, separated by a slash.

If this is used, it must contain exactly six colon characters (as field-separators between the seven days). If this 
is left empty, it will turn the whole opening hours system off (always showing as open, but without a schedule). To 
specify `EXTRA_HOURS` without any regular hours, set `HOURS` to `::::::`.

### `EXTRA_HOURS`

This is a comma-separated list of time intervals, each formatted as YYYY-MM-DDThh:mm/hh:mm. The end time must be
after the start time (you cannot have an interval that crosses midnight). This is ignored if `HOURS` is unset.

### `HOLIDAYS`

This is a comma-separated list of dates where the regular opening hours don't apply, each formatted as YYYY-MM-DD. 
This is ignored if `HOURS` is unset.

### `HOURS_DESCRIPTION`

This is a string describing the opening hours in a human-readable way. This is ignored if `HOURS` is unset.

### `TZ`

Timezone to use for opening hours. If this is unset, the server's timezone will be used.

### `MAIL_FROM_ADDRESS`

The from-address used for confirmation e-mails sent when a user adds or updates an e-mail address on their profile.
Either a bare address (`addr@domain`) or a `Display Name <addr@domain>` form may be used. Leave empty to disable
e-mail sending entirely (in that case profile updates that include an e-mail address will silently succeed without
sending a confirmation).

The deployment derives the sending domain from this address (the part after the `@`, ignoring any display name),
creates an AWS SES identity for it in the same region as `AWS_REGION`, and outputs the DNS records needed for
verification. Until the DNS records are in place, SES will not consider the identity verified and any send attempt will
fail.

The deployment outputs the exact records as CloudFormation stack outputs after each deploy:

- `MailDkimRecord1`, `MailDkimRecord2`, `MailDkimRecord3` — three CNAMEs, required for DKIM.
- `MailFromMxRecord`, `MailFromSpfRecord` — MX and TXT for the custom MAIL FROM subdomain, required for the MAIL FROM
  domain to verify.
- `MailSpfRecord`, `MailDmarcRecord` — recommended SPF and DMARC records on the from-domain itself. Tune `p=` and
  `rua=` on the DMARC record to your needs.

You can also re-print these records at any time without redeploying by running:

```
aws cloudformation describe-stacks --stack-name <your-stack> --region <your-region> --query 'Stacks[0].Outputs'
```

New AWS accounts have SES in *sandbox mode*, where you can only send to recipients whose addresses or domains have
also been verified in SES. To send to arbitrary recipients (which is what this backend needs in production), open a
case with AWS Support requesting production access for SES in your region. This is a one-time, account-wide change.
Until production access is granted, only e-mails to verified recipients will be delivered; the rest will be rejected
synchronously by SES, which the backend will surface as a 500-response from `/registerUser` or `/updateUser`.

### `SOURCE_URL`

Download link for the source code.
This must point to a repository
where the code that is actually deployed
can be downloaded
to comply with the license terms
of this project.

## Api

The following endpoints are available on the backend, once deployed.

### `GET /`

This endpoint will return some general information about the service.
It can be used to ensure the api is online and has a compatible version
and to check the opening hours.
It will return a `message`,
which is currently always `"Success"`,
along with an `apiVersion`-string
containing the major and minor version of the backend,
the `sourceUrl` where the code can be downloaded,
and an `openingHours`-object.
The latter will give the current `time` (as hh:mm)
in the time zone the service operates in,
a `status` indicating whether the service is currently `"open"` or `"closed"`,
a `description` with a human-readable version of the opening hours,
and a `schedule` for the next few days.
The `schedule` is intended to be both human-readable and machine parseable
and will take things like holidays and special opening hours into account.

Response format:

```
{
    message: "Success",
    apiVersion: string,
    sourceUrl: string,
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
    "sourceUrl": "https://github.com/valomedia/tower-backend",
    "openingHours": {
        "time": "13:37",
        "status": "open",
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

Optionally, profile information can be provided during registration. If an email is provided, it must be syntactically
valid and unique across all users. When an e-mail address is provided, the backend will send a confirmation e-mail to
that address before creating the user. If sending fails, the user is not created and an error response is returned.
All profile fields are optional and can also be set or updated later via the `/updateUser` endpoint.

Request format:

```
{
    firstName?: string,
    lastName?: string,
    email?: string,
    gender?: string,
    birthdate?: string,
    phone?: string
}
```

Example request (without the profile):

```json
{}
```

Example request (with the profile):

```json
{
    "firstName": "Anna",
    "lastName": "Müller",
    "email": "anna.mueller@example.com",
    "gender": "X",
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

- `{"error": "Invalid email address"}`
- `{"error": "Email already registered"}`
- `{"error": "Failed to send confirmation email"}`

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
          "username": "user_908d4e54-18cd-41f1-80fc-57779a108947",
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
assistance request per user at any given time, this is enough to determine the assistance request to update.

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
assistance request per user at any given time, this is enough to determine the assistance request to remove.

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

This endpoint retrieves an existing user's profile information. For now, no authentication is required – anyone with
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
        "gender": "X",
        "birthdate": "1990-05-15",
        "phone": "+49123456789"
    }
}
```

Error responses:

- `{"error": "Need parameter: userId"}`
- `{"error": "User not found"}`

### `POST /updateUser`

This endpoint allows updating an existing user's profile information. For now, no authentication is required – anyone
with the userId can update the profile. The user must already exist (have been registered via the `/registerUser`
endpoint).

The full profile must be provided. Any fields missing in the request will be removed from the profile on the backend. If
an email is provided, it must be syntactically valid and not be in use by another user. When the e-mail address is being
added or changed (compared to the previously stored value), the backend will send a confirmation e-mail to the new
address before saving the change. If sending fails, the profile is not updated and an error response is returned.

Request format:

```
{
    userId: UUID,
    firstName?: string,
    lastName?: string,
    email?: string,
    gender?: string,
    birthdate?: string,
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
    "gender": "X",
    "birthdate": "1990-05-15",
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

- `{"error": "Need parameter: userId"}`
- `{"error": "Invalid email address"}`
- `{"error": "Email already registered"}`
- `{"error": "User not found"}`
- `{"error": "Failed to send confirmation email"}`

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
        user: {username: string},
        startDateTime: string
    }
}
```

Example response:

```json
{
    "assistanceRequest": {
        "user": {
            "username": "user_908d4e54-18cd-41f1-80fc-57779a108947"
        },
        "startDateTime": "2025-01-08T19:27:59.759Z"
    }
}
```

### `POST /beginAssistance`

This will remove the oldest assistance request from the queue and return it, including the full user profile and a
meeting id that can later be passed to `/endAssistance`. If there aren't any open assistance requests, this endpoint
will respond with a 404-response.

Response format:

```
{
    meeting: string,
    assistanceRequest: {
        user: {
            username: string,
            communicationUserId: string,
            firstName?: string,
            lastName?: string,
            email?: string,
            gender?: string,
            birthdate?: string,
            phone?: string
        },
        startDateTime: string
    }
}
```

Example response:

```json
{
    "meeting": "3ef07231-bc85-4e66-a331-6a017e289723",
    "assistanceRequest": {
        "user": {
            "username": "user_908d4e54-18cd-41f1-80fc-57779a108947",
            "communicationUserId": "8:acs:86423206-6599-4274-a6c6-3f9108a2ab41_00000024-04d3-a94b-59fe-ad3a0d00e963",
            "firstName": "Anna",
            "lastName": "Müller",
            "email": "anna.mueller@example.com",
            "gender": "X",
            "birthdate": "1990-05-15",
            "phone": "+49123456789"
        },
        "startDateTime": "2025-01-08T19:27:59.759Z"
    }
}
```

### `POST /endAssistance`

This records that an answered assistance call has ended. The `meeting` is the id returned by `/beginAssistance`.
Set `nonBillable` to `true` to exclude the call from future billable minute totals; omitted or `false` keeps the call
billable.

Request format:

```
{
    meeting: string,
    nonBillable?: boolean
}
```

Example request:

```json
{
    "meeting": "3ef07231-bc85-4e66-a331-6a017e289723",
    "nonBillable": true
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

- `{"error": "Need parameter: meeting"}`
- `{"error": "Parameter nonBillable must be a boolean"}`
- `{"message": "Open meeting not found"}`

### `POST /createImageUploadUrl`

This will create a single-use URL the customer's app can use to upload an image to an S3-bucket. To prevent abuse, there 
isn't an endpoint the end-user apps can use to freely upload data. Instead, when the assistant wants to take a photo,
the app of the assistant will use this endpoint to generate an upload link that is only valid once. This upload link 
is then provided to the user's app, so it can upload the photo. The endpoint will return the `uploadURL`, along with a 
`key` that can be used to get a download url for the ressource later and the date the upload URL `expiresOn`.

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
