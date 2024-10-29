# node-debounce-cycle
Run a function on a set interval, with possibility for early runs

## Warnings

There is very little error-checking. Use at your own peril.

## Options

* `min`: minimum time between starts in milliseconds, or a function that returns milliseconds
* `max`: maximum time between starts in milliseconds, or a function that returns milliseconds. Used when cycling.
* `jitter`: milliseconds to randomly adjust the max (+ or -) to prevent a batch of requests at the same time
* `retry`: minimum time between starts in milliseconds when the run function returns an error, or a function that returns milliseconds

## Examples

```
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const run = async () => {
    const startDate = new Date();
    await sleep(500);
    return startDate;
}

const controller = new DebounceCycle(run, {
    min: 1000, // runs must start at least 1,000ms (1s) apart, except in retry
    max: 3000, // when cycling, start every 3,000ms (3s)
    jitter: 1000, // when cycling using max, adjust start time by +/- 1,000ms (1s)
    retry: 500, // when run returns an error, retry after 500ms
    start: false, // don't start cycling
    immediate: false // wait for at least min or max (depending on which is requested) on the first run
});

(async () => {
    const result1 = controller.request(); // requested with min
    const result2 = await controller.request(); // also requested with min
    console.log("Result 2", result2);
})();
```
