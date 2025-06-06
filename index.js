import https from "https";
import fsPromises from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_OWNER = "enter_repo_owner_here";
const REPO_NAME = "enter_repo_name_here";
const GITHUB_API_BASE_URL = "api.github.com";

// Output file names - name them whatever you'd like
const CONTRIBUTORS_CSV_FILE = "contributors.csv";
const COMMITS_CSV_FILE = "commits.csv";

// If you want to filter out bot commits
const BOT_USER_TO_FILTER = "dependabot[bot]";

// Optional: GitHub Personal Access Token (PAT)
// If you have a PAT, uncomment the line below and replace "your_github_pat_here" with your token
// This will significantly increase your rate limit
const GITHUB_TOKEN = "your_github_pat_here";

// Global object to store current rate limit information
let rateLimitInfo = {
    remaining: Infinity, // Initialize with a high value; will be updated after the first API call
    resetTimestamp: 0    // Unix timestamp (seconds) when the limit resets
};

// Threshold for remaining requests before pausing
const RATE_LIMIT_PAUSE_THRESHOLD = 10;

/**
 * Helper function to pause execution
 * @param {number} ms - Milliseconds to pause
*/
const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Escapes a string for CSV format
*/
const escapeCsvValue = (value) => {
    if (value === null || typeof value === "undefined") {
        return "";
    }
  
    const stringValue = String(value);
    if (stringValue.includes(",") || stringValue.includes("\n") || stringValue.includes('"')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }
  
    return stringValue;
}

/**
 * Converts an array of objects to a CSV string
*/
const convertToCsv = (dataArray, headers) => {
    if (!dataArray || dataArray.length === 0) {
        return "";
    }
  
    const actualHeaders = headers || Object.keys(dataArray[0]);
    const headerRow = actualHeaders.map(escapeCsvValue).join(",");
    const dataRows = dataArray.map(row =>
        actualHeaders.map(header => escapeCsvValue(row[header] || "")).join(",")
    );
  
    return [headerRow, ...dataRows].join("\n");
}

/**
 * Makes a GET request to the GitHub API and updates rate limit info
*/
const fetchGitHubAPI = (apiPath) => {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: GITHUB_API_BASE_URL,
            path: apiPath,
            method: "GET",
            headers: {
                "User-Agent": "Node.js GitHub API Client",
                "Accept": "application/vnd.github.v3+json"
            }
        };

        // Add Authorization header if GITHUB_TOKEN is defined and not empty
        if (typeof GITHUB_TOKEN !== "undefined" && GITHUB_TOKEN && GITHUB_TOKEN !== "YOUR_GITHUB_PAT_HERE") {
            options.headers['Authorization'] = `token ${GITHUB_TOKEN}`;
        }

        const req = https.request(options, (res) => {
            // Update rate limit information from headers
            if (res.headers["x-ratelimit-remaining"]) {
                rateLimitInfo.remaining = parseInt(res.headers["x-ratelimit-remaining"], 10);
            }
          
            if (res.headers["x-ratelimit-reset"]) {
                rateLimitInfo.resetTimestamp = parseInt(res.headers["x-ratelimit-reset"], 10);
            }
          
            // Log current rate limit status occasionally for visibility
            if (rateLimitInfo.remaining !== Infinity) {
                 console.log(`Rate limit status: ${rateLimitInfo.remaining} requests remaining. Resets at ${new Date(rateLimitInfo.resetTimestamp * 1000).toLocaleTimeString()}`);
            }


            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (error) {
                        reject(new Error(`Failed to parse JSON response: ${error.message} (Path: ${apiPath})`));
                    }
                } else {
                    let errorMessage = `GitHub API request failed for ${apiPath} with status code ${res.statusCode}`;
                  
                    try {
                        const errorResponse = JSON.parse(data);
                        if (errorResponse.message) {
                            errorMessage += `: ${errorResponse.message}`;
                        }
                      
                        if (errorResponse.documentation_url) {
                            errorMessage += ` (Docs: ${errorResponse.documentation_url})`;
                        }
                    } catch (e) { /* Ignore if error response is not JSON */ }
                     // The rate limit info would have been updated above from headers even for errors
                    errorMessage += ` (Rate Limit: ${rateLimitInfo.remaining}, Resets: ${new Date(rateLimitInfo.resetTimestamp * 1000).toLocaleTimeString()})`;
                    reject(new Error(errorMessage));
                }
            });
        });
        req.on("error", (error) => {
            if (error.code === "ENOTFOUND") {
                reject(new Error(`DNS lookup failed for ${options.hostname}. Check your internet connection and the hostname. Original error: ${error.message}`));
            } else {
                reject(new Error(`HTTPS request failed: ${error.message} (Path: ${apiPath})`));
            }
        });
        req.end();
    });
}

/**
 * Checks rate limits and pauses if necessary
*/
const checkAndHandleRateLimits = async () => {
    if (rateLimitInfo.remaining < RATE_LIMIT_PAUSE_THRESHOLD) {
        const now = Date.now();
        const resetTimeMs = rateLimitInfo.resetTimestamp * 1000;
        // Add a small buffer (e.g., 10 seconds) to ensure the limit has reset
        const waitTime = resetTimeMs - now + 10000;

        if (waitTime > 0) {
            console.warn(`Rate limit low (${rateLimitInfo.remaining}). Pausing for ${Math.ceil(waitTime / 1000)} seconds... Resuming around ${new Date(Date.now() + waitTime).toLocaleTimeString()}`);
            await sleep(waitTime);
            console.log("Resuming API calls...");
            // After sleeping, the rate limit should have reset
            // The next call to fetchGitHubAPI will update rateLimitInfo with fresh values
            // We'll optimistically set remaining high; next API call will get the true current value
             rateLimitInfo.remaining = Infinity; 
        }
    }
}


/**
 * Fetches all contributor data and writes it to a CSV file
*/
const processAllContributors = async () => {
    console.log(`Fetching all contributors for ${REPO_OWNER}/${REPO_NAME}...`);
  
    let allContributors = [];
    let page = 1;
    // Max items per page allowed by GitHub API
    const perPage = 100;

    try {
        while (true) {
            // Check rate limit before making a call
            await checkAndHandleRateLimits();

            // Include anon=1 to get anonymous contributors (i.e., those who haven't linked their git email to a GitHub account)
            const contributorsPath = `/repos/${REPO_OWNER}/${REPO_NAME}/contributors?per_page=${perPage}&page=${page}&anon=1`; 
            console.log(`Fetching contributors page ${page} (requesting up to ${perPage} contributors)...`);
            const contributorsPage = await fetchGitHubAPI(contributorsPath);

            if (contributorsPage && contributorsPage.length > 0) {
                allContributors.push(...contributorsPage);
              
                if (contributorsPage.length < perPage) {
                    console.log("Reached the end of the codebase's contributors");
                    break;
                }
              
                page++;
            } else {
                console.log("No more contributors found on this page, or an error occurred while fetching contributors");
                break;
            }
        }

        if (allContributors.length > 0) {
            console.log(`Found a total of ${allContributors.length} contributors`);
          
            const contributorDataForCsv = allContributors.map(c => ({
                // Handle anonymous contributors who have "type: Anonymous" and may have "name" and "email" but no "login"
                Login: c.login || (c.type === "Anonymous:" ? `Anonymous (${c.name || 'Unknown'})` : "N/A"),
                Contributions: c.contributions,
                ProfileURL: c.html_url || "N/A", // Anonymous contributors won't have a GitHub profile URL
                Type: c.type,
                Email: c.email || "N/A", // Often present for anonymous contributors
                Name: c.name || "N/A"   // Often present for anonymous contributors
            }));

            const csvHeaders = ["Login", "Contributions", "ProfileURL", "Type", "Name", "Email"];
            const csvData = convertToCsv(contributorDataForCsv, csvHeaders);
            const filePath = path.join(__dirname, CONTRIBUTORS_CSV_FILE);
            
            await fsPromises.writeFile(filePath, csvData);
            console.log(`All contributor data successfully saved to ${filePath}`);
        } else {
            console.log("No contributors were processed");
        }
    } catch (error) {
        // Likely a file system error
        if (error.code && error.path) {
             console.error(`Error writing contributors CSV to ${error.path}: ${error.message}`);
        } else {
            console.error(`Error fetching or processing contributors: ${error.message}`);
        }
    }
    console.log("-".repeat(50));
}

/**
 * Fetches all commit data (filtering out bot commits) and writes it to a CSV file
*/
const processAllCommits = async () => {
    console.log(`Fetching all commits for ${REPO_OWNER}/${REPO_NAME} (filtering out ${BOT_USER_TO_FILTER})...`);
  
    let allCommitsData = [];
    let page = 1;
    // Max items per page
    const perPage = 100;
    let filteredCommitsCount = 0;

    try {
        while (true) {
            await checkAndHandleRateLimits();

            const commitsPath = `/repos/${REPO_OWNER}/${REPO_NAME}/commits?per_page=${perPage}&page=${page}`;
            console.log(`Fetching commits page ${page} (requesting up to ${perPage} commits)...`);
            const commitsPage = await fetchGitHubAPI(commitsPath);

            if (commitsPage && commitsPage.length > 0) {
                const filteredCommitsFromPage = commitsPage.filter(commitData => {
                    // Exclude commit if the author is a bot
                    if (commitData.author && commitData.author.login === BOT_USER_TO_FILTER) {
                        filteredCommitsCount++;
                        return false;
                    }
                    return true;
                });

                if (filteredCommitsFromPage.length > 0) {
                    const commitsDataForCsv = filteredCommitsFromPage.map(commitData => ({
                        SHA: commitData.sha,
                        // If author is null (e.g., git commit not linked to GitHub user), use git author name
                        AuthorLogin: commitData.author ? commitData.author.login : (commitData.commit.author ? `Git: ${commitData.commit.author.name}` : "N/A"),
                        AuthorName: commitData.commit.author ? commitData.commit.author.name : "N/A",
                        AuthorEmail: commitData.commit.author ? commitData.commit.author.email : "N/A",
                        Date: commitData.commit.author ? new Date(commitData.commit.author.date).toISOString() : "N/A",
                        Message: commitData.commit.message.split("\n")[0]
                    }));
                  
                    allCommitsData.push(...commitsDataForCsv);
                }

                // The decision to fetch the next page is based on the length of the original (unfiltered) page
                if (commitsPage.length < perPage) {
                    console.log("Reached the end of commits");
                    break;
                }
              
                page++;
            } else {
                console.log("No more commits found on this page, or an error occurred while fetching commits");
                break;
            }
        }

        if (allCommitsData.length > 0) {
            console.log(`Fetched a total of ${allCommitsData.length} commits (after filtering)`);
          
            if (filteredCommitsCount > 0) {
                console.log(`Filtered out ${filteredCommitsCount} commits by ${BOT_USER_TO_FILTER}`);
            }
          
            const csvHeaders = ["SHA", "AuthorLogin", "AuthorName", "AuthorEmail", "Date", "Message"];
            const csvData = convertToCsv(allCommitsData, csvHeaders);
            const filePath = path.join(__dirname, COMMITS_CSV_FILE);

            await fsPromises.writeFile(filePath, csvData);
            console.log(`All commit data (filtered) successfully saved to ${filePath}`);

        } else {
            console.log("No commits were processed (or all were filtered out lol)");
          
            if (filteredCommitsCount > 0) {
                console.log(`Filtered out ${filteredCommitsCount} commits by ${BOT_USER_TO_FILTER}`);
            }
        }
    } catch (error) {
        // Likely a file system error
        if (error.code && error.path) {
             console.error(`Error writing commits CSV to ${error.path}: ${error.message}`);
        } else {
            console.error(`Error fetching or processing commits: ${error.message}`);
        }
    }
  
    console.log("-".repeat(50));
}

async function main() {
    console.log(`Starting GitHub repository data fetch for ${REPO_OWNER}/${REPO_NAME}`);
    if (typeof GITHUB_TOKEN !== "undefined" && GITHUB_TOKEN && GITHUB_TOKEN !== "your_github_pat_here") {
        console.log("Using GitHub Personal Access Token for authentication");
    } else {
        console.warn("WARNING: Making unauthenticated requests or GITHUB_TOKEN is not set");
        console.warn("You may hit rate limits very quickly");
        console.warn("For extensive data fetching, generate a GitHub Personal Access Token,");
        console.warn("uncomment the 'GITHUB_TOKEN' line, and replace 'your_github_pat_here' with your token");
    }
    console.log("====================================================\n");

    await processAllContributors();
    await processAllCommits();

    console.log('\nFinished fetching and writing all data');
    console.log(`Output files: ${CONTRIBUTORS_CSV_FILE}, ${COMMITS_CSV_FILE}`);
}

main();
