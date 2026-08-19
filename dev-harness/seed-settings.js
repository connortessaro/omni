// Seeds the settings a fresh browser profile has no way to have: which provider
// is selected, which model, and that images are allowed.
//
// Only fills what is missing, so a driven session can change a setting and have it
// survive a reload. Override per load with query params:
//   ?harnessProvider=gemini&harnessModel=gemini-2.5-flash
//
// The api_key value here is deliberately not a key. Provider requests carry
// `{{OMNI_SECRET:API_KEY}}` and the proxy substitutes the real value, so anything
// that still reads this field is reaching for a credential it should not have —
// and will fail loudly with a 401 instead of quietly working.
(() => {
  const params = new URLSearchParams(window.location.search);
  const provider = params.get("harnessProvider") ?? "gemini";
  const model = params.get("harnessModel") ?? "gemini-2.5-flash";

  const fillIfAbsent = (key, value) => {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, value);
    }
  };

  const force = params.has("harnessProvider") || params.has("harnessModel");
  const selected = JSON.stringify({
    provider,
    variables: { api_key: "harness-proxy-holds-the-key", model },
  });

  if (force) {
    localStorage.setItem("curl_selected_ai_provider", selected);
  } else {
    fillIfAbsent("curl_selected_ai_provider", selected);
  }

  fillIfAbsent("supports_images", "true");
  fillIfAbsent(
    "response_settings",
    JSON.stringify({
      responseLength: "auto",
      language: "english",
      autoScroll: true,
    })
  );

  console.log(`[harness] provider=${provider} model=${model}`);
})();
