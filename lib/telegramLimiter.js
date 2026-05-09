const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createSequentialLimiter = () => {
    let chain = Promise.resolve();
    return (task) => {
        const run = chain.then(task, task);
        chain = run.catch(() => {});
        return run;
    };
};

const getRetryAfterSeconds = (error) => {
    const sec = error?.response?.parameters?.retry_after;
    if (sec == null) return null;
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
};

const withTelegramRetry = async (fn, maxAttempts = 3) => {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const retryAfter = getRetryAfterSeconds(error);
            const code = error?.response?.error_code;
            if (code === 429 && retryAfter != null && attempt < maxAttempts) {
                await sleep((retryAfter + 1) * 1000);
                continue;
            }
            throw error;
        }
    }
    throw lastError;
};

module.exports = { createSequentialLimiter, withTelegramRetry };
