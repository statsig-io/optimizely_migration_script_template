# Optimizely => Statsig Migration Script Template

This script is designed to help automate some of the migration of feature flags from Optimizely to Statsig. It fetches feature flags from Optimizely, translates them into Statsig's format, and creates corresponding feature gates in Statsig.

## Considerations

This script should work out of the box. I'd suggesting getting started with a test environment of 5-10 flags. However, before running the script on a large scale, consider the following:

- The script only migrates flags with two variation values from Optimizely so they become booleans. Multiple variation flags require manual migration.
- The script uses a tag (`Migration Script from Optimizely`) to identify migrated flags in Statsig. Ensure this tag is unique and recognizable.
- The script includes a function to delete all Statsig feature gates with a specific tag. Use this with caution to clean up after a test or failed migration.
- The script maps only audience_lists for now.
- The script does not support a/b tests and skips over those rules.
- _IMPORTANT_ percentages are migrated, but they are likely evaluated to different populations at runtime, since hashing is not guaranteed to be the same in Optimizely.
- The script requires API keys for both Optimizely and Statsig, which should be kept secure.

## Installation

To run the script, you need Node.js and npm installed on your system. Follow these steps to set up the script:

1. Clone or download the script to your local machine.
2. Navigate to the script's directory in your terminal.
3. Run `npm install` to install the required dependency, `axios` for HTTP requests.

## Configuration

Before running the script, you must set up the following variables in the script:

- `OPTIMIZELY_API_KEY `: Your Optimizely API key.
- `STATSIG_CONSOLE_API_KEY`: Your Statsig console API key.

## Running the Script

To execute the migration script, run the following command in your terminal:

```bash
node index.js
```

The script will perform the following actions:

1. Fetch all feature flags from Optimizely.
2. Translate each flag into Statsig's format.
3. Create feature gates in Statsig.

Pull requests and feedback welcome!
