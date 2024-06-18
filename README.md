# Tower Backend

AWS SAM backend for Tower.

## Deployment

### Quick Start Guide

In order to deploy the backend, or update an existing deployment, you simply execute `npm run deploy` with the correct
options.

#### First Deployment

There is two ways to deploy the backend, depending on how you want to do the authentication for the web app (the mobile
app is unaffected by this).  Both are deployed using `deploy.js`, just with slightly different parameters.  All AWS
resources will be created automatically.  When the script finishes it outputs the url to the newly deployed backend,
which can be used as is, or assigned to a custom domain using the AWS API Gateway Console.  During each deployment, a
new temporary object will be created in an S3-bucket that is provided on the command line. The bucket is not emptied
automatically, so you might have to empty it manually every once in a while (or set a deletion rule), to avoid
unnecessary charges.

##### Reverse proxy

In reverse proxy mode, tower-staff itself is protected by basic auth.  This means the user will be prompted for
credentials immediately after opening the web-app.  To avoid having to reenter the credentials when accessing the
backend, the backend needs to be on the same origin as tower-staff.  This means tower-staff should be configured with
a relative path for the backend, and should proxy all requests below that path to the backend.

Deploying the backend in this mode will look something like this:

```shell
npm run deploy -- \
    -b tower-backend-prod \
    -s tower-backend-prod \
    --stage-name Prod \
    --auth-url https://auth.tower-assist.de
```

In this command, `tower-backend-prod` is the name of the bucket (`-b`) to build into (and deploy from) and the name 
of the CloudFormation stack (`-s`). The `--stage-name` is used as the stage name for the AWS SAM API. The actual name 
doesn't matter much, choose whatever name describes the purpose of that particular deployment. The `--auth-url` 
should be any url that the backend can GET and that checks the authorization header and answers `200 OK` if the user 
should be authorized and `401 UNAUTHORIZED` if the user should not be authorized.

##### Cross-Origin

In cross-origin mode, tower-staff can be accessed without authentication and the user will only be prompted for
credentials when tower-staff establishes a connection to the backend.  This allows operating the backend without a
reverse proxy in front of it.

Deploying the backend in this mode will look something like this:

```shell
npm run deploy -- \
    -b tower-backend-prod \
    -s tower-backend-prod \
    --stage-name Prod \
    --auth-url https://auth.tower-assist.de \
    --allow-origin https://staff.tower-assist.de
```

In this command, `tower-backend-prod` is the name of the bucket (`-b`) to build into (and deploy from) and the name 
of the CloudFormation stack (`-s`). The `--stage-name` is used as the stage name for the AWS SAM API. The actual name 
doesn't matter much, choose whatever name describes the purpose of that particular deployment. The `--auth-url` 
should be any url that the backend can GET and that checks the authorization header and answers `200 OK` if the user 
should be authorized and `401 UNAUTHORIZED` if the user should not be authorized. If tower-staff makes cross-origin 
requests, `--allow-origin` needs to be set to the origin the client is making the requests from. If tower-staff is 
configured to use a reverse proxy, this option can be left out.

#### Updating an Existing Deployment

In order to update your deployment, simply pull the changes to the code from upstream and rerun the deployment script
with the same parameter for `--stack-name`, and `--region`. All other parameters may be changed upon subsequent
deployments.

### Documentation

The deployment-script exposes several options.

#### `-h, --help`

Show help and exit.  This will print a quick summary of the available options.

#### `-r, --region`

Target region, default `eu-central-1`.  This is the AWS-region the SAM-Stack and S3 bucket will be created in, as well
as the default region for new meetings.

#### `-b, --bucket`

S3 bucket for deployment, required.  This is the name of a bucket that the application will be built in.  If the bucket
doesn't exist, it will be automatically created.  During deployment, the source will be copied to a new object in this
bucket, built there, then deployed to SAM from the bucket.  The object will no longer be needed afterward, but the
bucket is not emptied automatically.

#### `-s, --stack-name`

CloudFormation stack name, required.  This is the name for the CloudFormation stack to deploy the backend in.  It will
be created during deployment.  If an existing stack is given, the deployment will be updated.

#### `--stage-name`

SAM stage name, required. This is the stage name for the AWS SAM API. The stage name doesn't really matter, since 
there will always be exactly one stage in the stack. However, it is still useful to use a name that matches the purpose 
of the deployment (such as `Dev`, `Staging`, or `Prod`), to prevent confusion when assigning gateways to the various 
APIs down the road.

#### `--auth-url`

Endpoint to check basic auth tokens against, required.  This is the endpoint to query to check whether the user should
be authorized. The backend will make a GET-request to this endpoint, providing the user's authorization-header. If the
endpoint answers `200 OK`, the user will be authorized and the authorization will be cached for 5 minutes.

#### `--allow-origin`

Value for the Access-Control-Allow-Origin CORS-header, optional.  This is the content for the HTTP-header
Access-Control-Allow-Origin, it is used verbatim.  If you want to make cross-origin requests from tower-staff, this
needs to be the origin the tower-staff application is making the requests from.

#### `-l, --disable-printing-logs`

Disable printing logs.  If this flag is provided, the deploy script will produce less output.

## Api

The following endpoints are available on the backend, once deployed.

### `GET /`

This endpoint will simply reply `{message: "Success"}`, it is intended to be used to check whether the api is online
and the credentials are valid.

### `POST /join`

This endpoint will create the meeting if it doesn't exist yet, add an attendee and return all information necessary to
join the call.  No parameters need to be provided, the call location will be the same as the deployment location, the
user ID will be randomly generated and prefixed with the meeting ID. The meeting ID in turn will be taken from the
username used in the basic authorization header.

Response format:

```
    joinInfo: {
        meetingResponse: {
            Meeting: {
                externalMeetingId: String | null,
                primaryMeetingId: String | null,
                mediaPlacement: {
                    audioFallbackUrl: String | null,
                    audioHostUrl: String,
                    signalingUrl: String,
                    turnControlUrl: String | null,
                    eventIngestionUrl: String | null
                },
                mediaRegion: String,
                meetingId: String
            }
        },
        attendeeResponse: {
            Attendee: {
                attendeeId: String,
                externalUserId: String,
                joinToken: String
            }
        }
    }
```

Example response:

```
{
  "joinInfo": {
    "meetingResponse": {
      "Meeting": {
        "MeetingId": "fdee05b8-e3cd-41e4-a030-7b85a21c7979",
        "MeetingHostId": null,
        "ExternalMeetingId": "valomedia",
        "MediaRegion": "eu-central-1",
        "MediaPlacement": {
          "AudioHostUrl": "1ef752e5d51c7ae61dc98c489068e09d.k.m1.ec1.app.chime.aws:3478",
          "AudioFallbackUrl": "wss://haxrp.m1.ec1.app.chime.aws:443/calls/fdee05b8-e3cd-41e4-a030-7b85a21c7979",
          "SignalingUrl": "wss://signal.m1.ec1.app.chime.aws/control/fdee05b8-e3cd-41e4-a030-7b85a21c7979",
          "TurnControlUrl": "https://7979.cell.eu-central-1.meetings.chime.aws/v2/turn_sessions",
          "ScreenDataUrl": "wss://bitpw.m1.ec1.app.chime.aws:443/v2/screen/fdee05b8-e3cd-41e4-a030-7b85a21c7979",
          "ScreenViewingUrl": "wss://bitpw.m1.ec1.app.chime.aws:443/ws/connect?passcode=null&viewer_uuid=null&X-BitHub-Call-Id=fdee05b8-e3cd-41e4-a030-7b85a21c7979",
          "ScreenSharingUrl": "wss://bitpw.m1.ec1.app.chime.aws:443/v2/screen/fdee05b8-e3cd-41e4-a030-7b85a21c7979",
          "EventIngestionUrl": "https://data.svc.ue1.ingest.chime.aws/v1/client-events"
        },
        "PrimaryMeetingId": null,
        "TenantIds": [],
        "MeetingArn": "arn:aws:chime:eu-central-1:667381599324:meeting/fdee05b8-e3cd-41e4-a030-7b85a21c7979"
      }
    },
    "attendeeResponse": {
      "Attendee": {
        "ExternalUserId": "5de389f8#valomedia",
        "AttendeeId": "582e3b1f-115a-8024-a8dc-b3257e3e4856",
        "JoinToken": "NTgyZTNiMWYtMTE1YS04MDI0LWE4ZGMtYjMyNTdlM2U0ODU2OmMwZGM0NjE5LTMwNDgtNDc1Yy04NjY1LTg1ZGM4NmU5N2RiYw",
        "Capabilities": {
          "Audio": "SendReceive",
          "Video": "SendReceive",
          "Content": "SendReceive"
        }
      }
    }
  }
}
```

### `POST /end`

This endpoint will end the meeting, causing all attendee connections to hang up.  No parameters need to be provided,
the meeting ID will be taken from the username in the basic authorization header.  If successful, the response will be
an empty JSON-object.

### `POST /deleteAttendee`

This endpoint will remove an attendee from the meeting.  If successful, the response will be an empty JSON-object.

Query string parameters:
 * `attendeeId`: The `ExternalUserId` of the attendee to remove.

### `GET /poll`

Get the meeting, if one exists.  This is intended to be used to check whether there is a user waiting for assistance.
No parameters need to be provided, the meeting ID will be taken from the username in the basic authorization header. If
the request is successful, but no meeting exists, the response will be an empty JSON-object, if a meeting is found, the
Meeting will be returned as outlined below.

Response format:

```
    Meeting: {
        externalMeetingId: String | null,
        primaryMeetingId: String | null,
        mediaPlacement: {
            audioFallbackUrl: String | null,
            audioHostUrl: String,
            signalingUrl: String,
            turnControlUrl: String | null,
            eventIngestionUrl: String | null
        },
        mediaRegion: String,
        meetingId: String
    }
```

Example response:

``` 
{
  "Meeting": {
    "MeetingId": "6f725b2d-829b-4b1c-901e-38119da37979",
    "MeetingHostId": null,
    "ExternalMeetingId": "valomedia",
    "MediaRegion": "eu-central-1",
    "MediaPlacement": {
      "AudioHostUrl": "1411f548f5cad1e00e18e1d83ff87b03.k.m2.ec1.app.chime.aws:3478",
      "AudioFallbackUrl": "wss://haxrp.m2.ec1.app.chime.aws:443/calls/6f725b2d-829b-4b1c-901e-38119da37979",
      "SignalingUrl": "wss://signal.m2.ec1.app.chime.aws/control/6f725b2d-829b-4b1c-901e-38119da37979",
      "TurnControlUrl": "https://7979.cell.eu-central-1.meetings.chime.aws/v2/turn_sessions",
      "ScreenDataUrl": "wss://bitpw.m2.ec1.app.chime.aws:443/v2/screen/6f725b2d-829b-4b1c-901e-38119da37979",
      "ScreenViewingUrl": "wss://bitpw.m2.ec1.app.chime.aws:443/ws/connect?passcode=null&viewer_uuid=null&X-BitHub-Call-Id=6f725b2d-829b-4b1c-901e-38119da37979",
      "ScreenSharingUrl": "wss://bitpw.m2.ec1.app.chime.aws:443/v2/screen/6f725b2d-829b-4b1c-901e-38119da37979",
      "EventIngestionUrl": "https://data.svc.ue1.ingest.chime.aws/v1/client-events"
    },
    "PrimaryMeetingId": null,
    "TenantIds": [],
    "MeetingArn": "arn:aws:chime:eu-central-1:667381599324:meeting/6f725b2d-829b-4b1c-901e-38119da37979"
  }
}
```
