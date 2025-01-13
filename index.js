const axios = require('axios');

// Environment variables for API keys and project/environment identifiers
const OPTIMIZELY_API_KEY = '';
const STATSIG_CONSOLE_API_KEY = '';
// This tag will be placed on all of your Statsig gates that are imported
// It will be used to clean before migration runs and can be used for your internal accounting
const TAG_NAME = 'Migration Script from Optimizely';
// How an Optimizely environment maps to a Statsig environment. Use the key for each (not the name).
const ENVIRONMENT_MAPPING = {
  development: 'development',
  production: 'production',
};
// The default variations in Optimizely are "on" and "off". If they differ or if
// there's custom variations, add them here.  The boolean mapping is what is
// used in Statsig since Statsig flags always return a boolean.
const VARIATION_KEY_MAPPING = {
  on: true,
  off: false,
};

// API endpoints
const OPTIMIZELY_API_BASE_URL = 'https://api.optimizely.com/';
const STATSIG_API_BASE_URL = 'https://statsigapi.net/console/v1';

// Headers for Optimizely API requests
const optimizelyHeaders = {
  headers: { Authorization: 'Bearer ' + OPTIMIZELY_API_KEY },
};

// Headers for Statsig API requests
const statsigHeaders = {
  headers: {
    'STATSIG-API-KEY': STATSIG_CONSOLE_API_KEY,
    'Content-Type': 'application/json',
  },
};

async function listOptimizelyProjects() {
  const response = await axios.get(
    `${OPTIMIZELY_API_BASE_URL}/v2/projects`,
    optimizelyHeaders,
  );
  return response.data;
}

async function listOptimizelyFlags(projectId) {
  console.log(`Fetching flags for project ${projectId}...`);
  const response = await axios.get(
    `${OPTIMIZELY_API_BASE_URL}/flags/v1/projects/${projectId}/flags?per_page=1000`,
    optimizelyHeaders,
  );
  const flags = response.data.items;
  console.log(`...found ${flags.length} flags.`);

  console.log(`Getting rulesets and translating flags...`);
  const data = [];
  for (const flag of flags) {
    const description = `${flag.description} - created by ${flag.created_by_user_email}`;

    if (flag.archived) {
      data.push({
        key: flag.key,
        name: flag.name,
        description,
        warnings: [`Flag ${flag.key} is archived; skipping flag.`],
      });
    } else {
      const rulesetByEnvironment = {};

      for (const envName of Object.keys(flag.environments)) {
        // The response from the list rules API does not include the default
        // variation for each ruleset, so we need to fetch it separately.
        const rulesetResponse = await axios.get(
          `${OPTIMIZELY_API_BASE_URL}/flags/v1/projects/${projectId}/flags/${flag.key}/environments/${envName}/ruleset`,
          optimizelyHeaders,
        );
        const ruleset = rulesetResponse.data;
        rulesetByEnvironment[envName] = ruleset;
      }

      const { rules, errors, warnings, info } =
        translateOptimizelyToStatsigFlag(rulesetByEnvironment);
      data.push({
        key: flag.key,
        name: flag.name,
        description,
        rules,
        errors,
        warnings,
        info,
      });
    }
  }
  return data;
}

function translateOptimizelyToStatsigFlag(rulesetByEnvironment) {
  // If there's any errors in a rule, we don't create the Statsig flag.
  const errors = [];
  // Warnings are things you should double check.
  const warnings = [];
  // Info is more just logging.
  const info = [];

  const environmentToRules = (ruleset) => {
    // Optimizely separates rules by environment, but Statsig has a single
    // rules array.  Here we combine the rules for each environment into a
    // single array and have the rule name and rule environment to
    // differentiate.
    if (!ENVIRONMENT_MAPPING[ruleset.environment_key]) {
      // Modify this script; this isn't a flag-level error.
      throw new Error(
        `Optimizely environment ${ruleset.environment_key} has no Statsig environment mapping. Update the ENVIRONMENT_MAPPING variable.`,
      );
    }

    if (!ruleset.enabled) {
      // Rules cannot be disabled in Statsig, so we skip importing them.
      warnings.push(
        `Environment ${ruleset.environment_key} is disabled; rules are not imported.`,
      );
      return [];
    }

    const rulesetRules = ruleset.rule_priorities.map(
      (rule_key) => ruleset.rules[rule_key],
    );

    if (rulesetRules.some((r) => r.type === 'a/b')) {
      errors.push(
        `Environment ${ruleset.environment_key} has A/B rules which are not supported - delete these before migration; skipping environment.`,
      );
      return [];
    }

    const defaultVariation = ruleset.default_variation_key;
    const defaultVariationValue = VARIATION_KEY_MAPPING[defaultVariation];
    if (defaultVariationValue === undefined) {
      throw new Error(
        `Flag ${ruleset.flag_key} environment ${ruleset.environment_key} has a default variation ${defaultVariation} that is not mapped to a Statsig value. Update the VARIATION_KEY_MAPPING variable.`,
      );
    }

    // Make sure there are at most 2 variations.
    const allVariations = {};
    allVariations[defaultVariation] = true;
    rulesetRules.forEach((rule) => {
      const variation = Object.keys(rule.variations)[0];
      allVariations[variation] = true;
    });
    if (Object.keys(allVariations).length > 2) {
      errors.push(
        `Environment ${ruleset.environment_key} has more than 2 variations; skipping environment.`,
      );
      return [];
    }

    const rules = rulesetRules
      .map((rule) => {
        const ruleName = `(${ruleset.environment_key}) ${rule.name}`;

        if (rule.status === 'concluded') {
          info.push(
            `Rule ${ruleName} is in 'concluded' status; skipping rule.`,
          );
          return [];
        }

        // There is no 'pause' status in Statsig, so we don't include any
        // environments in the Statsig rule in order to have the rule but not have
        // it be active. 'concluded' rules are skipped above; they don't have a
        // variation so we can't create a placeholder rule.
        const environmentName =
          rule.status === 'running'
            ? ENVIRONMENT_MAPPING[ruleset.environment_key]
            : null;
        if (!environmentName) {
          info.push(
            `Rule ${ruleName} is not in 'running' status, so the Statsig environment is not set.`,
          );
        }
        const environments = [environmentName];

        if (Object.keys(rule.variations).length > 1) {
          throw new Error(
            `Environment ${ruleset.environment_key} has a rule ${ruleName} with more than 1 variation. This is unexpected.`,
          );
        }
        const variation = Object.keys(rule.variations)[0];
        const variationValue = VARIATION_KEY_MAPPING[variation];
        if (variationValue === undefined) {
          throw new Error(
            `Environment ${ruleset.environment_key} has a rule ${ruleName} with a variation ${variation} that is not mapped to a Statsig value. Update the VARIATION_KEY_MAPPING variable.`,
          );
        }

        let passPercentage;
        if (variationValue) {
          // If rule value is true, then the rule percentage is the percentage of users that should see the rule.
          passPercentage = rule.percentage_included / 100;
        } else if (!defaultVariationValue) {
          // If rule value is false and the default is also false, then the rule will be false for matching users.
          passPercentage = 0;
          info.push(
            `Ruleset ${ruleset.environment_key} default variation is false and rule ${ruleName} target variation is false; the pass percentage is set to 0 so that the rule will be false for matching users.`,
          );
        } else {
          // If rule value is false and the default is true, then we want to invert the percentage.
          passPercentage = 100 - rule.percentage_included / 100;
          info.push(
            `Ruleset ${ruleset.environment_key} default variation is true and rule ${ruleName} target variation is false; the pass percentage is inverted so that the rule will be true for matching users.`,
          );
        }

        if (passPercentage !== 0 || passPercentage !== 100) {
          warnings.push(
            `Ruleset ${ruleset.environment_key} has a rule ${ruleName} with a pass percentage of ${passPercentage} which is not 0 or 100; Statsig likely hashes the audience differently than Optimizely so this gate will pass for a different set of users than previously.`,
          );
        }

        let conditions;
        if (rule.audience_ids.length === 0) {
          // everyone
          conditions = [
            {
              type: 'public',
            },
          ];
        } else {
          // Does this field exist only on accounts allowlisted into some gate? I don't see it in my API response
          const audienceList = rule.audience_detail;
          if (!audienceList) {
            errors.push(
              `Rule ${ruleName} does not have an audience_detail field. Skipping rule.`,
            );
            return [];
          }

          if (
            audienceList.some(
              (audience) =>
                audience.user_ids.length > 0 && audience.org_ids.length > 0,
            )
          ) {
            // NYI
            errors.push(
              `Rule ${ruleName} has audience_detail with both user ids and org ids. Skipping rule.`,
            );
            return [];
          }

          conditions = audienceList.map((audience) => {
            if (audience.user_ids.length > 0) {
              return {
                type: 'user_id',
                targetValue: audience.user_ids,
                operator: 'any',
              };
            } else if (audience.org_ids.length > 0) {
              // This can also be a custom ID if configured that way.
              return {
                type: 'custom_field',
                targetValue: audience.org_ids,
                operator: 'any',
                field: 'org_id',
              };
            }
          });
        }

        // Because conditions in Optimizely are OR'ed, we have to create multiple rules for each condition.
        return conditions.map((condition, idx) => ({
          name: `${ruleName} (${idx})`,
          environments,
          passPercentage,
          conditions: [condition],
        }));
      })
      .flat(1);

    if (defaultVariationValue) {
      // If Optimizely ruleset defaults to true, then we need to create a rule that always passes.
      rules.push({
        name: `(${ruleset.environment_key}) always pass`,
        environments: [ENVIRONMENT_MAPPING[ruleset.environment_key]],
        passPercentage: 100,
        conditions: [
          {
            type: 'public',
          },
        ],
      });
    }

    return rules;
  };

  const rules = [];
  for (const env of Object.values(rulesetByEnvironment)) {
    rules.push(...environmentToRules(env));
  }

  return { rules, errors, warnings, info };
}

// deletes feature gates from Statsig with specified tagName - designed to help clean up a test/failed migration
async function deleteFeatureFlagsWithTag(tagName) {
  try {
    // Step 1: Fetch all feature flags
    const flagsResponse = await axios.get(
      `${STATSIG_API_BASE_URL}/gates`,
      statsigHeaders,
    );

    const flags = flagsResponse.data.data;

    console.log('Found ' + flags.length + ' feature gates in Statsig.');

    // Step 2: Filter flags that have the specified tag
    const flagsToDelete = flags.filter((flag) => flag.tags.includes(tagName));

    console.log(
      'Found ' +
        flagsToDelete.length +
        " feature gates tagged with '" +
        TAG_NAME +
        "'",
    );

    // Step 3: Delete each flagged feature flag
    for (const flag of flagsToDelete) {
      await axios.delete(
        `${STATSIG_API_BASE_URL}/gates/${flag.id}`,
        statsigHeaders,
      );
    }

    console.log(
      'SUCCESS All Statsig feature flags tagged "' +
        TAG_NAME +
        '" have been cleaned up.',
    );
  } catch (error) {
    console.error(
      'FAILED deleting feature gates:',
      error.response?.data || error.message,
    );
    throw error.response?.data || error.message;
  }
}

//Ensure the TAG_NAME tag is created, and if not, create it
async function checkAndCreateTag(tagName) {
  try {
    // Step 1: Fetch existing tags to check if the tag already exists
    const tagsResponse = await axios.get(
      `${STATSIG_API_BASE_URL}/tags`,
      statsigHeaders,
    );

    const tags = tagsResponse.data.data;
    const tagExists = tags.some((tag) => tag.name === tagName);

    // Step 2: If the tag doesn't exist, create it
    if (!tagExists) {
      const createTagResponse = await axios.post(
        `${STATSIG_API_BASE_URL}/tags`,
        {
          name: tagName,
          description: 'Tags migrated from the LD to Statsig migration script',
        },
        statsigHeaders,
      );

      console.log(`Tag "${tagName}" created successfully.`);
      return createTagResponse.data;
    } else {
      //console.log(`Tag "${tagName}" already exists.`);
      return null;
    }
  } catch (error) {
    //console.error('Error checking or creating tag:', error);
    if (error.response.data.errors) {
      console.log(`Error creating Tag "${tagName}".`);
      console.log(error.response.data.errors);
    }
    throw error;
  }
}

// Function to create a feature gate
async function createStatsigFeatureGate(featureGate) {
  const { key, name, description, rules, errors, warnings, info } = featureGate;
  console.log(`Creating feature gate ${key} - ${name}`);
  if (errors && errors.length > 0) {
    console.log('  - errors:');
    errors.forEach((error) => {
      console.log(`    - ${error}`);
    });
    console.log('  - has errors, skipping feature gate.');
    return false;
  }
  if (warnings && warnings.length > 0) {
    console.log('  - warnings:');
    warnings.forEach((warning) => {
      console.log(`    - ${warning}`);
    });
  }
  if (info && info.length > 0) {
    console.log('  - info:');
    info.forEach((info) => {
      console.log(`    - ${info}`);
    });
  }

  try {
    const response = await axios.post(
      `${STATSIG_API_BASE_URL}/gates`,
      {
        id: key,
        name,
        description,
        rules,
        tags: [TAG_NAME],
      },
      statsigHeaders,
    );
    return response.data;
  } catch (error) {
    console.error(
      'Error creating feature gate named "' + featureGate.name + '" -',
      error.response?.data,
    );
    return false;
  }
}

async function migrateOptimizelyFlags(projectId) {
  await deleteFeatureFlagsWithTag(TAG_NAME);
  await checkAndCreateTag(TAG_NAME);

  const flags = await listOptimizelyFlags(projectId);
  const results = [];
  for (const flag of flags) {
    const result = await createStatsigFeatureGate(flag);
    results.push(result);
  }
  console.log(
    `Created ${results.filter(Boolean).length} feature gates; skipped ${
      results.length - results.filter(Boolean).length
    }.`,
  );
}

function showAvailableCommands() {
  console.log('Available commands:');
  console.log('  list-projects       List all Optimizely projects');
  console.log(
    '  list-flags <projectId>    List all Optimizely flags for a project',
  );
  console.log(
    '  migrate-flags <projectId>    Migrate all Optimizely flags for a project',
  );
}

// Get command line argument
const command = process.argv[2];

// Execute based on command
if (command === 'list-projects') {
  listOptimizelyProjects()
    .then((projects) => {
      console.log('Projects:');
      projects.forEach((project) => {
        console.log(`- ID ${project.id}: ${project.name}`);
      });
    })
    .catch((error) => {
      console.error('Error listing projects:', error.message);
    });
} else if (command === 'list-flags') {
  const projectId = process.argv[3];
  if (!projectId) {
    console.log('Please provide a project ID');
  } else {
    listOptimizelyFlags(projectId).then((flags) => {
      console.log('Flags:');
      flags.forEach((flag) => {
        console.log(`- ${flag.key}: ${flag.name}`);
        if (flag.errors.length > 0) {
          console.log('  - errors:');
          flag.errors.forEach((error) => {
            console.log(`    - ${error}`);
          });
        }
        if (flag.warnings.length > 0) {
          console.log('  - warnings:');
          flag.warnings.forEach((warning) => {
            console.log(`    - ${warning}`);
          });
        }
        if (flag.info.length > 0) {
          console.log('  - info:');
          flag.info.forEach((info) => {
            console.log(`    - ${info}`);
          });
        }
      });
    });
  }
} else if (command === 'migrate-flags') {
  const projectId = process.argv[3];
  if (!projectId) {
    console.log('Please provide a project ID');
  } else {
    migrateOptimizelyFlags(projectId);
  }
} else {
  showAvailableCommands();
}
