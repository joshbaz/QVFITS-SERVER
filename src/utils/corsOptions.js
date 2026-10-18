import { env } from '../env.mjs';


/* This code snippet is defining a configuration object named `corsOptions` that is used for
configuring Cross-Origin Resource Sharing (CORS) in a Node.js application. Here's a breakdown of
what each property in the `corsOptions` object does:

origin: This property specifies the origins that are allowed to access the resources. It is an array
that includes the following origins:

- 'http://localhost:3000': The local development server.
- 'http://localhost:5173': The local development server for React.

credentials: This property specifies whether the resource can be shared with credentials (e.g., cookies,
HTTP authentication) or not. By setting it to `true`, the resource will allow credentials to be sent
and received from the origin.

methods: This property specifies the HTTP methods that are allowed for the resource. It is an array
that includes the following methods:

- 'GET': Allows reading the resource.
- 'POST': Allows creating a new resource.
- 'PUT': Allows updating an existing resource.
- 'DELETE': Allows deleting a resource.
- 'OPTIONS': Allows querying the supported HTTP methods.

allowedHeaders: This property specifies the headers that are allowed in the request. It is an array that includes the following headers:

- 'Content-Type': The type of content in the request body.
- 'Authorization': The authorization header for authentication.

preflightContinue: This property specifies whether the server should continue processing the request
after the preflight request has been made. By setting it to `false`, the server will not wait for   
the preflight request to complete before sending the response.

optionsSuccessStatus: This property specifies the status code that should be returned for the preflight request. By setting it to `204`, the server will return a 204 No Content status code for the preflight request.

This configuration allows the server to handle CORS requests from the specified origins with the allowed methods and headers, and to return a 204 status code for the preflight request.    
*/
export const corsOptions = {
    origin: [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
        'http://localhost:5176',
        'http://localhost:5177',
        'http://localhost:5178',
        'http://localhost:5180',
        'http://localhost:5181',
        'http://localhost:8888',

    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id', 'x-client-ip', 'x-ticket-token'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
};
