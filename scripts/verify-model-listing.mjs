// Runs the app's own listModels against a live provider, so the endpoint table
// and response parsers are checked against reality rather than only against
// stubs. Model APIs move: an id that existed last month can be gone today.
//
//   set -a; . ~/.config/omni/eval.env; set +a
//   node scripts/verify-model-listing.mjs
//   node scripts/verify-model-listing.mjs --provider openai
import { loadSrcModule } from "../evals/harness/loadSrcModule.ts";


const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
};

const providerId = arg("provider") ?? process.env.OMNI_EVAL_PROVIDER;
const apiKey = arg("key") ?? process.env.OMNI_EVAL_API_KEY;

if (!providerId) {
  console.error(
    "No provider. Pass --provider <id> or set OMNI_EVAL_PROVIDER."
  );
  process.exit(1);
}

// listModels reads a key out of the provider's configured variables.
const variables = { API_KEY: apiKey ?? "" };

const { listModels } = await loadSrcModule("lib/functions/models.function.ts");

const { AI_PROVIDERS } = await loadSrcModule(
  "config/ai-providers.constants.ts"
);
const curl = AI_PROVIDERS.find((p) => p.id === providerId)?.curl;

console.log(`Listing models for "${providerId}" through the app's own code...`);

try {
  const models = await listModels({ providerId, variables, curl });
  console.log(`\n${models.length} chat model(s):`);
  for (const model of models.slice(0, 20)) console.log(`  ${model}`);
  if (models.length > 20) console.log(`  ... and ${models.length - 20} more`);
} catch (error) {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
