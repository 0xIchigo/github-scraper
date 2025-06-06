# GitHub Scraper
![github-scraper](https://github.com/user-attachments/assets/8e63ddb6-10e7-4bdf-a91a-39ea8120158d)

Extract all commits and contributors for a given codebase and put it into a nice CSV file (then Excel go brrrrrrrrr)

## How To Run
- In `index.js`, rename `REPO_OWNER` and `REPO_NAME` to the GitHub repo of your choice (e.g., `firedancer-io` and `firedancer`, respectively, to fetch data on Firedancer's codebase)
- (Optional): Update line 23 with your GitHub Personal Access Token (PAT)—highly recommended for better rate limits and generating one is straightforward
- Literally just run `node index.js` and you're golden
