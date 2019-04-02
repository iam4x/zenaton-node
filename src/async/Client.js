const { ExternalZenatonError, InvalidArgumentError } = require("../Errors");
const workflowManager = require("./Workflows/WorkflowManager");
const http = require("./Services/Http");
const serializer = require("./Services/Serializer");
const { version } = require("../infos");
const { init, credentials } = require("../client");

const ZENATON_API_URL = "https://api.zenaton.com/v1";
const ZENATON_WORKER_URL = "http://localhost";
const DEFAULT_WORKER_PORT = 4001;
const WORKER_API_VERSION = "v_newton";

const MAX_ID_SIZE = 256;

const APP_ENV = "app_env";
const APP_ID = "app_id";
const API_TOKEN = "api_token";

const ATTR_ID = "custom_id";
const ATTR_NAME = "name";
const ATTR_CANONICAL = "canonical_name";
const ATTR_DATA = "data";
const ATTR_PROG = "programming_language";
const ATTR_INITIAL_LIB_VERSION = "initial_library_version";
const ATTR_CODE_PATH_VERSION = "code_path_version";
const ATTR_MODE = "mode";
const ATTR_MAX_PROCESSING_TIME = "maxProcessingTime";

const PROG = "Javascript";
const INITIAL_LIB_VERSION = version;
const CODE_PATH_VERSION = "async";

const EVENT_INPUT = "event_input";
const EVENT_NAME = "event_name";

const WORKFLOW_KILL = "kill";
const WORKFLOW_PAUSE = "pause";
const WORKFLOW_RUN = "run";

let instance;

module.exports = class Client {
  constructor(worker = false) {
    if (instance) {
      if (
        !worker &&
        (!credentials.appId || !credentials.apiToken || !credentials.appEnv)
      ) {
        console.log(
          "Please initialize your Zenaton client with your credentials",
        );
        // throw new ExternalZenatonError('Please initialize your Zenaton client with your credentials')
      }
      return instance;
    }
    instance = this;
  }

  static init(appId, apiToken, appEnv) {
    /* This was moved in a singleton module because whatever client is used to
     * init the credentials, they need to be shared between all code paths
     * clients */
    init(appId, apiToken, appEnv);
  }

  /**
   * Returns the worker url
   * This is for legacy purposes
   * @param {String} ressources REST Resources
   * @param {String} params Query string
   * @returns {String} Url
   */
  getWorkerUrl(ressources = "", params = "") {
    const paramsAsObject = params.split("&").reduce((acc, param) => {
      const [key, value] = param.split("=");
      acc[key] = value;
      return acc;
    }, {});

    const fullParams = Object.assign(paramsAsObject, this.getAppEnv());

    const queryString = Object.keys(fullParams)
      .map(
        (key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(fullParams[key])}`,
      )
      .join("&");

    const url = this.getWorkerUrlNew(ressources);
    return `${url}?${queryString}`;
  }

  getWorkerUrlNew(ressources = "") {
    const host = process.env.ZENATON_WORKER_URL
      ? process.env.ZENATON_WORKER_URL
      : ZENATON_WORKER_URL;
    const port = process.env.ZENATON_WORKER_PORT
      ? process.env.ZENATON_WORKER_PORT
      : DEFAULT_WORKER_PORT;
    const path = `/api/${WORKER_API_VERSION}/${ressources}`;

    return `${host}:${port}${path}`;
  }

  getWebsiteUrl(ressources = "") {
    const host = process.env.ZENATON_API_URL
      ? process.env.ZENATON_API_URL
      : ZENATON_API_URL;
    const path = `/${ressources}`;

    return `${host}${path}`;
  }

  /**
   * Start a task instance
   */
  async startTask(task) {
    const url = this.getTaskWorkerUrl();

    // start task
    const body = {
      [ATTR_PROG]: PROG,
      [ATTR_INITIAL_LIB_VERSION]: INITIAL_LIB_VERSION,
      [ATTR_CODE_PATH_VERSION]: CODE_PATH_VERSION,
      [ATTR_NAME]: task.name,
      [ATTR_DATA]: serializer.encode(task.data),
      [ATTR_MAX_PROCESSING_TIME]:
        typeof task.getMaxProcessingTime === "function"
          ? task.getMaxProcessingTime()
          : null,
    };

    const params = this.getAppEnv();

    return http.post(url, body, { params });
  }

  /**
   * Start a workflow instance
   */
  async startWorkflow(flow) {
    // custom id management
    let customId = null;
    if (typeof flow.id === "function") {
      // customId can be a value or a function
      customId = flow.id();
      // customId should be a string or a number
      if (typeof customId !== "string" && typeof customId !== "number") {
        throw new InvalidArgumentError(
          `Provided id must be a string or a number - current type: ${typeof customId}`,
        );
      }
      // at the end, it's a string
      customId = customId.toString();
      // should be not more than 256 bytes;
      if (customId.length >= MAX_ID_SIZE) {
        throw new ExternalZenatonError(
          `Provided id must not exceed ${MAX_ID_SIZE} bytes`,
        );
      }
    }

    const url = this.getInstanceWorkerUrl();

    // start workflow
    const body = {
      [ATTR_PROG]: PROG,
      [ATTR_INITIAL_LIB_VERSION]: INITIAL_LIB_VERSION,
      [ATTR_CODE_PATH_VERSION]: CODE_PATH_VERSION,
      [ATTR_CANONICAL]: flow._getCanonical(),
      [ATTR_NAME]: flow.name,
      [ATTR_DATA]: serializer.encode(flow.data),
      [ATTR_ID]: customId,
    };

    const params = this.getAppEnv();

    return http.post(url, body, { params });
  }

  /**
   * Kill a workflow instance
   */
  async killWorkflow(workflowName, customId) {
    return this.updateInstance(workflowName, customId, WORKFLOW_KILL);
  }

  /**
   * Pause a workflow instance
   */
  async pauseWorkflow(workflowName, customId) {
    return this.updateInstance(workflowName, customId, WORKFLOW_PAUSE);
  }

  /**
   * Resume a workflow instance
   */
  async resumeWorkflow(workflowName, customId) {
    return this.updateInstance(workflowName, customId, WORKFLOW_RUN);
  }

  /**
   * Find a workflow instance
   */
  async findWorkflow(workflowName, customId) {
    const url = this.getInstanceWebsiteUrl();

    const params = Object.assign(
      {
        [ATTR_ID]: customId,
        [ATTR_NAME]: workflowName,
        [ATTR_PROG]: PROG,
        [ATTR_INITIAL_LIB_VERSION]: INITIAL_LIB_VERSION,
        [ATTR_CODE_PATH_VERSION]: CODE_PATH_VERSION,
        [API_TOKEN]: credentials.apiToken,
      },
      this.getAppEnv(),
    );

    return http
      .get(url, { params })
      .then((body) =>
        workflowManager.getWorkflow(workflowName, body.data.properties),
      );
  }

  /**
   * Send an event to a workflow instance
   */
  async sendEvent(workflowName, customId, eventName, eventData) {
    const url = this.getSendEventURL();

    const body = {
      [ATTR_PROG]: PROG,
      [ATTR_INITIAL_LIB_VERSION]: INITIAL_LIB_VERSION,
      [ATTR_CODE_PATH_VERSION]: CODE_PATH_VERSION,
      [ATTR_NAME]: workflowName,
      [ATTR_ID]: customId,
      [EVENT_NAME]: eventName,
      [EVENT_INPUT]: serializer.encode(eventData),
    };

    const params = this.getAppEnv();

    return http.post(url, body, { params });
  }

  async updateInstance(workflowName, customId, mode) {
    const url = this.getInstanceWorkerUrl();

    const body = {
      [ATTR_PROG]: PROG,
      [ATTR_INITIAL_LIB_VERSION]: INITIAL_LIB_VERSION,
      [ATTR_CODE_PATH_VERSION]: CODE_PATH_VERSION,
      [ATTR_NAME]: workflowName,
      [ATTR_MODE]: mode,
    };

    const params = Object.assign(
      {
        [ATTR_ID]: customId,
      },
      this.getAppEnv(),
    );

    return http.put(url, body, { params });
  }

  getInstanceWebsiteUrl() {
    return this.getWebsiteUrl("instances");
  }

  getInstanceWorkerUrl() {
    return this.getWorkerUrlNew("instances");
  }

  getTaskWorkerUrl() {
    return this.getWorkerUrlNew("tasks");
  }

  getSendEventURL() {
    return this.getWorkerUrlNew("events");
  }

  getAppEnv() {
    // when called from worker, APP_ENV and APP_ID is not defined
    const params = {};

    if (credentials.appEnv) {
      params[APP_ENV] = credentials.appEnv;
    }

    if (credentials.appId) {
      params[APP_ID] = credentials.appId;
    }

    return params;
  }
};
