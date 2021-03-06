import * as WebRequest from "web-request";
import fs = require("fs");
import url = require("url");
import tfsConstants = require("./tfsconstants");
import taskConstants = require("./taskconstants");

let options: WebRequest.RequestOptions;

export interface IBuild {
    name: string;
    id: string;
    result: string;
    status: string;
}

interface ITfsGetResponse<T> {
    count: number;
    value: T[];
}

interface IArtifact {
    id: string;
    name: string;
    resource: IArtifactResource;
}

interface IArtifactResource {
    downloadUrl: string;
}

export function initialize(authenticationMethod: string, username: string, password: string, tfsServer: string, ignoreSslError: boolean)
: void {
    var baseUrl: string = `${encodeURI(tfsServer)}/${taskConstants.ApiUrl}/`;

    if (authenticationMethod === taskConstants.AuthenticationMethodDefaultCredentials) {
        console.warn("Default Credentials are not supported anymore - will try to use OAuth Token- Please change your configuration");
        console.warn("Make sure Options-Allow Access To OAuth Token is enabled for your build definition.");
        authenticationMethod = taskConstants.AuthenticationMethodOAuthToken;
        password = "";
    }

    switch (authenticationMethod) {
        case taskConstants.AuthenticationMethodOAuthToken:
            console.log("Using OAuth Access Token");

            var authenticationToken: string;
            if (password === null || password === "") {
                console.log("Trying to fetch authentication token from system...");
                authenticationToken = `${process.env[tfsConstants.OAuthAccessToken]}`;
            } else {
                authenticationToken = password;
            }

            options = {
                baseUrl: baseUrl, auth: {
                    bearer: authenticationToken
                }
            };
            break;
        case taskConstants.AuthenticationMethodBasicAuthentication:
            console.log("Using Basic Authentication");
            options = {
                baseUrl: baseUrl, auth: {
                    user: username,
                    password: password
                }
            };

            break;
        case taskConstants.AuthenticationMethodPersonalAccessToken:
            console.log("Using Personal Access Token");

            options = {
                baseUrl: baseUrl,
                auth: {
                    user: "whatever",
                    password: password
                }
            };
            break;
        default:
            throw new Error("Cannot handle authentication method " + authenticationMethod);
    }

    options.headers = {
        "Content-Type": "application/json"
    };
    options.agentOptions = { rejectUnauthorized: !ignoreSslError };
    options.encoding = "utf-8";
}

export async function getBuildsByStatus(buildDefinitionName: string, statusFilter: string): Promise<IBuild[]> {
    var buildDefinitionID: string = await getBuildDefinitionId(buildDefinitionName);

    var requestUrl: string =
        `build/builds?api-version=2.0&definitions=${buildDefinitionID}&statusFilter=${statusFilter}`;

    var result: ITfsGetResponse<IBuild> = await WebRequest.json<ITfsGetResponse<IBuild>>(requestUrl, options);

    return result.value;
}

export async function triggerBuild(
    buildDefinitionName: string, branch: string, requestedFor: string, sourceVersion: string, buildParameters: string): Promise<string> {
    var buildId: string = await getBuildDefinitionId(buildDefinitionName);
    var queueBuildUrl: string = "build/builds?api-version=2.0";

    var queueBuildBody: string = `{ definition: { id: ${buildId} }`;
    if (branch !== null) {
        queueBuildBody += `, sourceBranch: \"${branch}\"`;
    }

    if (requestedFor !== undefined) {
        queueBuildBody += `, ${requestedFor}`;
    }

    if (sourceVersion !== undefined) {
        queueBuildBody += `, ${sourceVersion}`;
    }

    if (buildParameters !== null) {
        queueBuildBody += `, parameters: \"{${buildParameters}}\"`;
    }

    queueBuildBody += "}";

    console.log(`Queue new Build for definition ${buildDefinitionName}`);

    var result: WebRequest.Response<string> = await WebRequest.post(queueBuildUrl, options, queueBuildBody);

    return JSON.parse(result.content).id;
}

export async function waitForBuildsToFinish(triggeredBuilds: string[], failIfNotSuccessful: boolean): Promise<boolean> {
    var result: boolean = true;
    for (let queuedBuildId of triggeredBuilds) {
        var buildFinished: boolean = await isBuildFinished(queuedBuildId);

        if (!buildFinished) {
            console.log(`Build ${queuedBuildId} has not yet completed`);
            result = false;
        } else {
            result = result && true;
            console.log(`Build ${queuedBuildId} has completed`);
            var buildSuccessful: boolean = await wasBuildSuccessful(queuedBuildId);

            if (failIfNotSuccessful && !buildSuccessful) {
                throw new Error(`Build ${queuedBuildId} was not successful - failing task.`);
            }
        }
    }

    return result;
}

export async function downloadArtifacts(buildId: string, downloadDirectory: string): Promise<void> {
    console.log(`Downloading artifacts for ${buildId}`);

    if (!fs.existsSync(downloadDirectory)) {
        console.log(`Directory ${downloadDirectory} does not exist - will be created`);
        fs.mkdirSync(downloadDirectory);
    }

    if (!downloadDirectory.endsWith("\\")) {
        downloadDirectory += "\\";
    }

    var requestUrl: string = `build/builds/${buildId}/artifacts`;
    var result: ITfsGetResponse<IArtifact> = await WebRequest.json<ITfsGetResponse<IArtifact>>(requestUrl, options);

    if (result.count === undefined) {
        console.log(`No artifacts found for build ${buildId} - skipping...`);
    }

    console.log(`Found ${result.count} artifact(s)`);

    for (let artifact of result.value) {
        console.log(`Downloading artifact ${artifact.name}...`);

        var fileFormat : any = url.parse(artifact.resource.downloadUrl, true).query.$format;

        // if for whatever reason we cannot get the file format from the url just try with zip.
        if (fileFormat === null || fileFormat === undefined) {
            fileFormat = "zip";
        }

        var fileName: string = `${artifact.name}.${fileFormat}`;
        var index: number = 1;

        while (fs.existsSync(`${downloadDirectory}${fileName}`)) {
            console.log(`${fileName} already exists...`);
            fileName = `${artifact.name}${index}.${fileFormat}`;
            index++;
        }

        options.baseUrl = "";
        options.headers = {
            "Content-Type": `application/${fileFormat}`
        };
        options.encoding = null;

        var request: WebRequest.Request<void> = await WebRequest.stream(artifact.resource.downloadUrl, options);
        await request.pipe(fs.createWriteStream(downloadDirectory + fileName));

        console.log(`Stored artifact here: ${downloadDirectory}${fileName}`);
    }
}

async function isBuildFinished(buildId: string): Promise<boolean> {
    var requestUrl: string = `build/builds/${buildId}?api-version=2.0`;
    var result: IBuild = await WebRequest.json<IBuild>(requestUrl, options);

    return result.status === taskConstants.BuildStateCompleted;
}

async function wasBuildSuccessful(buildId: string): Promise<boolean> {
    var requestUrl: string = `build/builds/${buildId}?api-version=2.0`;
    var result: IBuild = await WebRequest.json<IBuild>(requestUrl, options);

    return result.result === taskConstants.BuildResultSucceeded;
}

async function getBuildDefinitionId(buildDefinitionName: string): Promise<string> {
    var requestUrl: string = `build/definitions?api-version=2.0&name=${encodeURIComponent(buildDefinitionName)}`;

    var result: ITfsGetResponse<IBuild> = await WebRequest.json<ITfsGetResponse<IBuild>>(requestUrl, options);

    if (result.count === 0) {
        throw new Error(`Did not find any build definition with this name: ${buildDefinitionName}
        - checked following url: ${options.baseUrl}${requestUrl}`);
    }

    return result.value[0].id;
}