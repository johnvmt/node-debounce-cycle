class DebounceCycle {
    constructor(callback, options = {}) {

        this._callback = callback;

        this._options = {
            immediate: true,
            start: true,
            jitter: 0,
            ...options
        };

        // TODO validate max, min and retry
        this._max = this._options.max;
        this._min = this._options.min;
        this._retry = this._options.retry;
        this._jitter = this._options.jitter;

        this._requestPromises = new Map();

        this._status = DebounceCycle.STATUSES.STOPPED;

        if(this._options.start) // start automatically
            this.start();
    }

    get attempts() {
        return this._attempts;
    }

    get status() {
        return this._status;
    }

    /**
     * sleep time before retrying, if attempt fails
     */
    get retry() {
        if(typeof this._retry === 'function')
            return this._retry(this.attempts); // pass number of attempts completed (first will be 1)
        else
            return this._retry;
    }

    /**
     * Minimum time in ms between start of cycles
     */
    get min() {
        if(typeof this._min === 'function')
            return this._min();
        else
            return this._min;
    }

    /**
     * Maximum time in ms between start of cycles, if cycling is in effect
     * Includes jitter, if it is set
     */
    get max() {
        let maxWithJitter;
        if(typeof this._max === 'function')
            maxWithJitter = this._max();
        else if(typeof this._max === 'number' && this._max > 0)
            maxWithJitter = this._max;
        else
            return undefined;

        if(this._jitter) {
            const jitterFactor = Math.random() * 2 - 1;
            return maxWithJitter + (jitterFactor * this._jitter);
        }
    }

    /**
     * Minimum time in ms between start of cycles
     * If value is a function, it will be called each time module.min is accessed
     */
    set min(msOrFunction) {
        if(msOrFunction !== this._min) {
            this._min = msOrFunction;

            if(this.status === DebounceCycle.STATUSES.SLEEPING && this._nextRunRequestSource === DebounceCycle.RUNREQUESTTYPE.MIN) {
                clearTimeout(this._sleepTimeout);
                delete this._nextRunStartTime;
                this._status = DebounceCycle.STATUSES.STOPPED;
                this._requestRun(DebounceCycle.RUNREQUESTTYPE.MIN);
            }
        }
    }

    /**
     * Maximum time in ms between start of cycles
     * If value is a function, it will be called each time module.min is accessed
     */
    set max(msOrFunction) {
        if(msOrFunction !== this._max) {
            this._max = msOrFunction;

            if(this.status === DebounceCycle.STATUSES.SLEEPING && this._nextRunRequestSource === DebounceCycle.RUNREQUESTTYPE.MAX) {
                clearTimeout(this._sleepTimeout);
                delete this._nextRunStartTime;
                this._status = DebounceCycle.STATUSES.STOPPED;
                this._requestRun(DebounceCycle.RUNREQUESTTYPE.MAX);
            }
        }
    }

    set jitter(ms) {
        if(ms !== this._jitter) {
            this._jitter = ms;

            if(this.status === DebounceCycle.STATUSES.SLEEPING && this._nextRunRequestSource === DebounceCycle.RUNREQUESTTYPE.MAX) {
                clearTimeout(this._sleepTimeout);
                delete this._nextRunStartTime;
                this._status = DebounceCycle.STATUSES.STOPPED;
                this._requestRun(DebounceCycle.RUNREQUESTTYPE.MAX);
            }
        }
    }

    /**
     * Maximum time in ms between start of cycles, if an attempt fails
     * If value is a function, it will be called each time module.min is accessed
     */
    set retry(msOrFunction) {
        if(msOrFunction !== this._retry) {
            this._retry = msOrFunction;

            if(this.status === DebounceCycle.STATUSES.SLEEPING && this._nextRunRequestSource === DebounceCycle.RUNREQUESTTYPE.RETRY) {
                clearTimeout(this._sleepTimeout);
                delete this._nextRunStartTime;
                this._status = DebounceCycle.STATUSES.STOPPED;
                this._requestRun(DebounceCycle.RUNREQUESTTYPE.RETRY);
            }
        }
    }

    /**
     * Start cycling (calling run function every max ms)
     */
    start() {
        this._cycling = true;
        this._requestRun(DebounceCycle.RUNREQUESTTYPE.MAX);
    }

    /**
     * Stop cycling (calling run function every max ms)
     */
    stop() {
        this._cycling = false;

        // currently awaiting a run
        if(this.status === DebounceCycle.STATUSES.SLEEPING && this._nextRunRequestSource === DebounceCycle.RUNREQUESTTYPE.MAX) {
            clearTimeout(this._sleepTimeout);
            this._status = DebounceCycle.STATUSES.STOPPED;
        }
    }

    request() {
        let resolvePromise;
        let rejectPromise;

        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });

        this._requestPromises.set(promise, {resolve: resolvePromise, reject: rejectPromise});

        this._requestRun(DebounceCycle.RUNREQUESTTYPE.MIN);

        return promise;
    }

    _sleepTimeFromRequestType(runRequestType) {
        if(runRequestType === DebounceCycle.RUNREQUESTTYPE.MAX)
            return this.max;
        else if(runRequestType === DebounceCycle.RUNREQUESTTYPE.MIN)
            return this.min;
        else if(runRequestType === DebounceCycle.RUNREQUESTTYPE.RETRY)
            return this.retry;
        else
            throw new Error(`Unknown request source`);
    }

    /**
     * Returns milliseconds until next run can start, based on the request type and previous runs
     * @param {*} runRequestType
     * @returns
     */
    _timeToNextRunStart(runRequestType) {
        if(!this._lastRunStartTime && this._options.immediate) // no previous runs and should run immediately
            return 0;
        else {
            const sleepTime = this._sleepTimeFromRequestType(runRequestType);

            if(typeof sleepTime === 'number') {
                if(!this._lastRunStartTime) // no previous run (and no immediate)
                    return sleepTime;
                else // has previously run
                    return Math.max(0, (this._lastRunStartTime + sleepTime) - Date.now());
            }
        }
    }

    _requestRun(runRequestType) {
        this._log('debug', `Got request to run from source: ${runRequestType}`);

        if(this.status !== DebounceCycle.STATUSES.RUNNING && this._nextRunRequestSource !== runRequestType) { // not already running and not the same request source (request source sleep times can change)
            this._log('debug', `Not already running, and new run request source is different from currently-sleeping source (if any)`);
            const timeToRequestedNextRunStartTime = this._timeToNextRunStart(runRequestType); // get requested ms to next start, based on request method and previous run

            // if currently sleeping, check if time to next start
            if(timeToRequestedNextRunStartTime === undefined) {
                this._log('debug', `Sleep time is not set. Stopping.`);

                // if currently sleeping, clear timeout of previously-set sleep
                if(this._sleepTimeout)
                    clearTimeout(this._sleepTimeout);

                this._status = DebounceCycle.STATUSES.STOPPED;
            }
            else if(timeToRequestedNextRunStartTime > 0) { // would need to sleep for some time before next start
                this._log('debug', `Sleep time > 0. Compare to currently-sleeping (if any) to determine which should be honored.`);
                const requestedNextRunStartTime = Date.now() + timeToRequestedNextRunStartTime; // calculate time next run would start, given the request

                if(!this._nextRunStartTime || requestedNextRunStartTime < this._nextRunStartTime) { // no next run set, or requested run would start before currently-sleeping request
                    if(!this._nextRunStartTime)
                        this._log('debug', `New request scheduled to start at (${requestedNextRunStartTime}. Sleep for ${timeToRequestedNextRunStartTime}.`);
                    else
                        this._log('debug', `New request scheduled to start sooner than previous request (${requestedNextRunStartTime} vs ${this._nextRunStartTime}). Sleep for ${timeToRequestedNextRunStartTime}.`);

                    // if currently sleeping, clear timeout of previously-set sleep
                    if(this._sleepTimeout)
                        clearTimeout(this._sleepTimeout);

                    // set up new sleep timer
                    this._nextRunStartTime = Date.now() + timeToRequestedNextRunStartTime; // target time for next run to start
                    this._nextRunRequestSource = runRequestType;
                    this._status = DebounceCycle.STATUSES.SLEEPING;

                    this._sleepTimeout = setTimeout(() => {
                        this._log('debug', `Finished sleeping`);
                        // clean up vars set only for sleeping
                        delete this._nextRunRequestSource;
                        delete this._nextRunStartTime;

                        this._run();
                    }, timeToRequestedNextRunStartTime);
                }
                else
                    this._log('debug', `Previous request will start sooner than new request. Discarding new request.`);
            }
            else {
                this._log('debug', `Sleep time is 0. Run immediately.`);
                delete this._nextRunRequestSource;
                delete this._nextRunStartTime;
                this._run();
            }
        }
        else
            this._log('debug', `Conditions not met to request new run. Skipping.`)
    }

    /**
     * Resolve all requestor promises with callback success result
     * @param {*} result
     */
    _pushCallbackSuccess(result) {
        const requestPromises = this._requestPromises;
        this._requestPromises = new Map(); // reset the map for the next request

        for(let {resolve} of requestPromises.values()) {
            try {
                resolve(result);
            }
            catch(error) {
                // TODO log this somehow
            }
        }
    }

    /**
     * Reject all requestor promises with callback error
     * @param {*} error
     */
    _pushCallbackError(error) {
        const requestPromises = this._requestPromises;
        this._requestPromises = new Map(); // reset the map for the next request

        for(let {reject} of requestPromises.values()) {
            try {
                reject(error);
            }
            catch(error) {
                this._log(error.message);
            }
        }
    }

    /**
     * Run the callback, and optionally start the next cycle
     * @returns {Promise<void>}
     * @private
     */
    async _run() {
        this._status = DebounceCycle.STATUSES.RUNNING;
        this._lastRunStartTime = Date.now();
        try {
            if(this._attempts === undefined)
                this._attempts = 0;
            this._attempts++; // first attempt = 1

            const result = await this._callback();
            this._status = DebounceCycle.STATUSES.STOPPED;

            delete this._attempts; // delete when success

            this._pushCallbackSuccess(result);
            if(this._cycling) {
                this._log('debug', 'Run completed and cycling. Requesting new run with MAX source.');
                this._requestRun(DebounceCycle.RUNREQUESTTYPE.MAX); // cycle
            }
            else
                this._log('debug', 'Run completed and not cycling. Stopping.');
        }
        catch(error) {
            this._status = DebounceCycle.STATUSES.STOPPED;
            // retry
            this._pushCallbackError(error);
            this._requestRun(DebounceCycle.RUNREQUESTTYPE.RETRY);
        }
    }

    _log(level, ...messageParts) {
        if(this._options.logger)
            this._options.logger[level](messageParts.join(' '));
    }

    static RUNREQUESTTYPE = Object.freeze({
        MIN: 'MIN',
        MAX: 'MAX',
        RETRY: 'RETRY'
    });

    static STATUSES = Object.freeze({
        STOPPED: 'STOPPED',
        SLEEPING: 'SLEEPING',
        RUNNING: 'RUNNING'
    });
}

export default DebounceCycle;
