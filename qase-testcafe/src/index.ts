/* eslint-disable no-console,@typescript-eslint/require-await */
/* eslint-disable camelcase */
/* eslint-disable no-unused-vars */
import { CustomBoundaryFormData, customBoundary } from './CustomBoundaryFormData';
import {
    IdResponse, ResultCreate, ResultCreateStatusEnum,
} from 'qaseio/dist/src';
import {createReadStream, readFileSync} from 'fs';
import { QaseApi } from 'qaseio';
import chalk from 'chalk';
import {execSync} from 'child_process';
import moment from 'moment';
import path from 'path';
import RuntimeError = WebAssembly.RuntimeError;

interface Config {
    enabled: boolean;
    apiToken: string;
    basePath?: string;
    rootSuiteTitle?: string;
    projectCode: string;
    runId: string | number | undefined;
    runName: string;
    runDescription?: string;
    runComplete: boolean;
    uploadAttachments: boolean;
    environmentId: string | number | undefined;
    logging: boolean;
}

interface Meta {
    [key: string]: string;
}

interface Screenshot {
    screenshotPath: string;
    thumbnailPath: string;
    userAgent: string;
    quarantineAttempt: number;
    takenOnFail: boolean;
}

interface TestRunInfo {
    errs: Array<Record<string, unknown>>;
    warnings: string[];
    durationMs: number;
    unstable: boolean;
    screenshotPath: string;
    screenshots: Screenshot[];
    quarantine: { [key: string]: { passed: boolean } };
    skipped: boolean;
}

interface Test {
    name: string;
    meta: Meta;
    info: TestRunInfo;
    error: string;
}

const loadJSON = (file: string): Config | undefined => {
    try {
        const data = readFileSync(file, { encoding: 'utf8' });

        if (data) {
            return JSON.parse(data) as Config;
        }
    } catch (error) {
        // Ignore error when file does not exist or it's malformed
    }

    return undefined;
};

const prepareConfig = (options: Config = {} as Config): Config => {
    const loaded = loadJSON(path.join(process.cwd(), '.qaserc'));
    if (!loaded) {
        throw new RuntimeError();
    }
    const config: Config = Object.assign(
        loaded,
        options
    );

    return {
        enabled: process.env.QASE_ENABLED === 'true' || config.enabled || false,
        apiToken: process.env.QASE_API_TOKEN || config.apiToken,
        basePath: process.env.QASE_API_BASE_URL || config.basePath,
        rootSuiteTitle: process.env.QASE_ROOT_SUITE_TITLE || config.rootSuiteTitle || '',
        projectCode: process.env.QASE_PROJECT || config.projectCode || '',
        runId: process.env.QASE_RUN_ID || config.runId || '',
        runName:
            process.env.QASE_RUN_NAME ||
            config.runName ||
            'Automated Run %DATE%',
        runDescription:
            process.env.QASE_RUN_DESCRIPTION || config.runDescription,
        runComplete:
            process.env.QASE_RUN_COMPLETE === 'true' || config.runComplete,
        uploadAttachments:
            process.env.QASE_UPLOAD_ATTACHMENTS === 'true' || config.uploadAttachments,
        environmentId: process.env.QASE_ENVIRONMENT_ID || config.environmentId || undefined,
        logging: process.env.QASE_LOGGING !== '' || config.logging,
    };
};

const prepareReportName = (
    config: Config,
    userAgents: string[]
) => {
    const date = moment().format();
    return config.runName
        .replace('%DATE%', date)
        .replace('%AGENTS%', `(${userAgents.join(', ')})`);
};

const verifyConfig = (config: Config) => {
    const { enabled, apiToken, projectCode } = config;
    if (enabled) {
        if (!projectCode) {
            console.log('[Qase] Project Code should be provided');
        }
        if (apiToken && projectCode) {
            return true;
        }
    }

    return false;
};

class TestcafeQaseReporter {
    private config: Config;
    private api: QaseApi;
    private enabled: boolean;

    private userAgents!: string[];
    private pending: Array<(runId: string | number) => void> = [];
    private results: ResultCreate[] = [];
    private screenshots: {
        [key: string]: Screenshot[];
    };
    private queued: number;
    private fixtureName: string;

    public constructor() {
        this.config = prepareConfig();
        this.enabled = verifyConfig(this.config);
        this.api = new QaseApi(
            this.config.apiToken,
            this.config.basePath,
            TestcafeQaseReporter.createHeaders(),
            CustomBoundaryFormData,
        );
        this.queued = 0;
        this.fixtureName = '';
        this.screenshots = {};
    }

    private static getCaseId(meta: Meta): string[] {
        if (!meta.CID) {
            return [];
        }
        return meta.CID as unknown as string[];
    }

    private static createHeaders() {
        const { version: nodeVersion, platform: os, arch } = process;
        const npmVersion = execSync('npm -v', { encoding: 'utf8' }).replace(/['"\n]+/g, '');
        const qaseapiVersion = this.getPackageVersion('qaseio');
        const testcafeVersion = this.getPackageVersion('testcafe');
        const testcafeCaseReporterVersion = this.getPackageVersion('testcafe-reporter-qase');
        const xPlatformHeader = `node=${nodeVersion}; npm=${npmVersion}; os=${os}; arch=${arch}`;
        // eslint-disable-next-line max-len
        const xClientHeader = `testcafe=${testcafeVersion as string}; qase-testcafe=${testcafeCaseReporterVersion as string}; qaseapi=${qaseapiVersion as string}`;

        return {
            'X-Client': xClientHeader,
            'X-Platform': xPlatformHeader,
        };
    }

    private static createRunObject(name: string, cases: number[], args?: {
        description?: string;
        environment_id: number | undefined;
        is_autotest: boolean;
    }) {
        return {
            title: name,
            cases,
            ...args,
        };
    }

    private static getPackageVersion(name: string) {
        const UNDEFINED = 'undefined';
        try {
            const pathToPackageJson = require.resolve(`${name}/package.json`, { paths: [process.cwd()] });
            if (pathToPackageJson) {
                try {
                    const packageString = readFileSync(pathToPackageJson, { encoding: 'utf8' });
                    if (packageString) {
                        const packageObject = JSON.parse(packageString) as { version: string };
                        return packageObject.version;
                    }
                    return UNDEFINED;
                } catch (error) {
                    return UNDEFINED;
                }
            }
        } catch (error) {
            return UNDEFINED;
        }
    }

    public reportTaskStart = async (_startTime: number, userAgents: string[]) => {
        if (!this.enabled) {
            return;
        }
        this.userAgents = userAgents;
        this.config.runName = prepareReportName(this.config, this.userAgents);

        return this.checkProject(
            this.config.projectCode,
            async (prjExists): Promise<void> => {
                if (!prjExists) {
                    this.log(
                        chalk`{red Project ${this.config.projectCode} does not exist}`
                    );
                    this.enabled = false;
                    return;
                }

                this.log(chalk`{green Project ${this.config.projectCode} exists}`);
                if (this.config.runId) {
                    this.saveRunId(this.config.runId);
                    return this.checkRun(this.config.runId, (runExists: boolean) => {
                        if (runExists) {
                            this.log(
                                chalk`{green Using run ${this.config.runId} to publish test results}`
                            );
                        } else {
                            this.log(chalk`{red Run ${this.config.runId} does not exist}`);
                            this.enabled = false;
                        }
                    });
                } else {
                    return this.createRun(
                        this.config.runName,
                        this.config.runDescription,
                        (created) => {
                            if (created) {
                                this.saveRunId(created.result?.id);
                                this.log(
                                    chalk`{green Using run ${this.config.runId} to publish test results}`
                                );
                            } else {
                                this.log(
                                    chalk`{red Could not create run in project ${this.config.projectCode}}`
                                );
                                this.enabled = false;
                            }
                        }
                    );
                }
            }
        );
    };

    public reportFixtureStart = async (name) => {
        this.fixtureName = String(name);
    };

    public reportTestDone = async (
        name: string,
        testRunInfo: TestRunInfo,
        meta: Meta,
        formatError: (x: Record<string, unknown>) => string
    ) => {
        if (!this.enabled) {
            return;
        }
        this.queued ++;
        const hasErr = testRunInfo.errs.length;
        let testStatus: ResultCreateStatusEnum;

        if (testRunInfo.skipped) {
            testStatus = ResultCreateStatusEnum.SKIPPED;
        } else if (hasErr > 0) {
            testStatus = ResultCreateStatusEnum.FAILED;
        } else {
            testStatus = ResultCreateStatusEnum.PASSED;
        }

        const errorLog = testRunInfo.errs
            .map((x: Record<string, unknown>) => formatError(x).replace(
                /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
                ''
            ))
            .join('\n');

        let attachmentsArray: any[] = [];
        if (this.config.uploadAttachments && testRunInfo.screenshots.length > 0) {
            attachmentsArray = await this.uploadAttachments(testRunInfo);
        }

        this.prepareCaseResult({name, info: testRunInfo, meta, error: errorLog}, testStatus, attachmentsArray);
    };

    public reportTaskDone = async () => {
        if (!this.enabled) {
            return;
        }
        await new Promise((resolve, reject) => {
            let timer  = 0;
            const interval = setInterval( () => {
                timer ++;
                if (this.config.runId && this.queued === 0) {
                    clearInterval(interval);
                    resolve();
                }
                if (timer > 30) {
                    clearInterval(interval);
                    reject();
                }
            }, 1000);
        });

        if (this.results.length === 0) {
            console.warn(
                `\n(Qase Reporter)
                                \nNo testcases were matched.
                                Ensure that your tests are declared correctly.\n`
            );
        } else {
            const body = {
                results: this.results,
            };
            await this.api.results.createResultBulk(
                this.config.projectCode,
                Number(this.config.runId),
                body
            );
            this.log('Results sent to Qase');

            if (this.config.runComplete) {
                await this.completeRun(this.config.runId);
            }
        }
    };

    private async completeRun(runId: string | number | undefined) {
        if (runId !== undefined) {
            await this.api.runs.completeRun(this.config.projectCode, Number(this.config.runId))
                .then(() => {
                    this.log('Run completed successfully');
                })
                .catch((err) => {
                    this.log(`Error on completing run ${err as string}`);
                });
        }
    }

    private log(message?: any, ...optionalParams: any[]) {
        if (this.config.logging){
            console.log(chalk`{bold {blue qase:}} ${message}`, ...optionalParams);
        }
    }

    private async checkProject(projectCode: string, cb: (exists: boolean) => Promise<void>): Promise<void> {
        try {
            const resp = await this.api.projects.getProject(projectCode);
            await cb(Boolean(resp.data.result?.code));
        } catch (err) {
            this.log(`Error on checking project ${err as string}`);
            this.enabled = false;
        }
    }

    private async createRun(
        name: string | undefined,
        description: string | undefined,
        cb: (created: IdResponse | undefined) => void
    ): Promise<void> {
        try {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const runObject = TestcafeQaseReporter.createRunObject(
                name || `Automated run ${new Date().toISOString()}`,
                [],
                {
                    description: description || 'TestCafe automated run',
                    environment_id: Number(this.config.environmentId),
                    is_autotest: true,
                }
            );
            const res = await this.api.runs.createRun(
                this.config.projectCode,
                runObject
            );
            cb(res.data);
        } catch (err) {
            this.log(`Error on creating run ${err as string}`);
            this.enabled = false;
        }
    }

    private async checkRun(runId: string | number | undefined, cb: (exists: boolean) => void): Promise<void> {
        if (runId === undefined) {
            cb(false);
            return;
        }

        return this.api.runs.getRun(this.config.projectCode, Number(runId))
            .then((resp) => {
                this.log(`Get run result on checking run ${resp.data.result?.id as unknown as string}`);
                cb(Boolean(resp.data.result?.id));
            })
            .catch((err) => {
                this.log(`Error on checking run ${err as string}`);
                this.enabled = false;
            });

    }

    private saveRunId(runId?: string | number) {
        this.config.runId = runId;
        if (this.config.runId) {
            while (this.pending.length) {
                this.log(`Number of pending: ${this.pending.length}`);
                const cb = this.pending.shift();
                if (cb) {
                    cb(this.config.runId);
                }
            }
        }
    }

    private logTestItem(name: string, status: ResultCreateStatusEnum) {
        const map = {
            failed: chalk`{red Test ${name} ${status}}`,
            passed: chalk`{green Test ${name} ${status}}`,
            pending: chalk`{blueBright Test ${name} ${status}}`,
            skipped: chalk`{blueBright Test ${name} ${status}}`,
        };
        if (status) {
            this.log(map[status]);
        }
    }

    private prepareCaseResult(test: Test, status: ResultCreateStatusEnum, attachments: any[]){
        this.logTestItem(test.name, status);
        this.queued --;
        const caseObject: ResultCreate = {
            status,
            time_ms: test.info.durationMs,
            stacktrace: test.error,
            comment: test.error ? test.error.split('\n')[0]:undefined,
            attachments: attachments.length > 0
                ? attachments
                : undefined,
        };
        if (!test.meta.CID) {
            caseObject.case = {
                title: test.name,
                suite_title: this.config.rootSuiteTitle
                    ? this.config.rootSuiteTitle + '\t' + this.fixtureName
                    : this.fixtureName,
            };
            this.results.push(caseObject);
        } else {
            const caseIds = TestcafeQaseReporter.getCaseId(test.meta);
            caseIds.forEach((caseId) => {
                if (caseId) {
                    const add = caseIds.length > 1 ? chalk` {white For case ${caseId}}`:'';
                    this.log(
                        chalk`{gray Ready for publishing: ${test.name}}${add}`
                    );
                    const caseObjectWithId: ResultCreate = {
                        case_id: parseInt(caseId, 10),
                        ...caseObject,
                    };
                    this.results.push(caseObjectWithId);
                }
            });
        }
    }

    private async uploadAttachments(testRunInfo: TestRunInfo) {
        return await Promise.all(
            testRunInfo.screenshots.map(async (attachment) => {
                const data = createReadStream(attachment?.screenshotPath);

                const options = {
                    headers: {
                        'Content-Type': 'multipart/form-data; boundary=' + customBoundary,
                    },
                };

                const response = await this.api.attachments.uploadAttachment(
                    this.config.projectCode,
                    [data],
                    options
                );

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                return (response.data.result?.[0].hash as string);
            })
        );
    }
}

/// This weird setup is required due to TestCafe prototype injection method.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export = () => {
    const reporter = new TestcafeQaseReporter();
    return {
        reportTaskStart: reporter.reportTaskStart,
        reportFixtureStart: reporter.reportFixtureStart,
        async reportTestDone(
            name: string,
            testRunInfo: TestRunInfo,
            meta: Meta
        ): Promise<void> {
            return reporter.reportTestDone(
                name,
                testRunInfo,
                meta,
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-expect-error Inject testrail error formatting method with bound context
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access
                this.formatError.bind(this)
            );
        },
        reportTaskDone: reporter.reportTaskDone,
        reporter,
    };
};
