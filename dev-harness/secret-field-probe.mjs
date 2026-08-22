// Drives the Dev space API key field and asserts it never holds a credential.
//
// This exists because the control's whole purpose is invisible to every other
// gate we have. A typecheck cannot tell the difference between a field bound to
// `selectedProvider.variables.api_key` and one bound to the credential store,
// and a unit test cannot see what React actually rendered. The regression it
// guards against is a quiet one: put the value back into component state or into
// the persisted provider and the panel looks and behaves exactly the same, while
// the plaintext copy this whole change removed is back on disk at mode 644.
//
// So the assertions are about what the field does NOT do. It reports whether a
// key is saved by asking Rust, it never reads one back, and typing one never
// reaches localStorage.
//
// WebKit for the same reason probe.mjs uses it: the app ships in WKWebView.
//
// Usage: npm run dev:harness   (in another shell, for the Tauri mock)
//        npm run secret:probe
import { webkit } from "playwright";

const APP_URL = process.env.HUD_URL ?? "http://localhost:1420/";
const ROUTE = "/dev-space";
const SECRET = "sk-probe-should-never-persist";

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};

/** Every value the webview has persisted, as one searchable blob. */
const persisted = (page) =>
  page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      out[key] = localStorage.getItem(key);
    }
    return JSON.stringify(out);
  });

const field = (page) => page.locator('input[type="password"]').first();
const saveButton = (page) => page.locator('button[title="Save key"]').first();
const removeButton = (page) => page.locator('button[title="Remove key"]').first();
const confirmButton = (page) =>
  page.locator('button[title="Confirm remove key"]').first();
const savedLine = (page) => page.getByText(/^Key saved/).first();

const run = async () => {
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

  try {
    await page.goto(new URL(ROUTE, APP_URL).href, { waitUntil: "load" });
    await field(page).waitFor({ state: "visible", timeout: 15000 });

    // The mock reports a stored secret by default, so the configured state is
    // what loads first.
    const startsSaved = await savedLine(page).isVisible();
    record(
      "a stored credential renders as saved without being read back",
      startsSaved && (await field(page).inputValue()) === "",
      startsSaved
        ? `field value is "${await field(page).inputValue()}"`
        : "no saved line rendered"
    );

    // One click arms, a second click removes. The key only exists in the
    // keychain, so an immediate delete on a 44px target loses it for good.
    await removeButton(page).click();
    await confirmButton(page).waitFor({ state: "visible", timeout: 5000 });
    record(
      "one click on remove asks for confirmation instead of deleting",
      await page.getByText(/Press again to remove/).first().isVisible(),
      "the control is armed, not fired"
    );

    // Letting the window lapse is what proves the first click deleted nothing:
    // the saved state comes back because the credential was never touched.
    await savedLine(page).waitFor({ state: "visible", timeout: 10000 });
    record(
      "an unconfirmed removal lapses and leaves the key in place",
      await savedLine(page).isVisible(),
      await savedLine(page).innerText()
    );

    await removeButton(page).click();
    await confirmButton(page).click();
    await savedLine(page).waitFor({ state: "hidden", timeout: 5000 });
    record(
      "confirming the removal clears the saved state",
      !(await savedLine(page).isVisible()),
      "saved line gone after secret_delete"
    );

    await field(page).fill(SECRET);
    const beforeSave = await persisted(page);
    record(
      "typing a key does not persist it",
      !beforeSave.includes(SECRET),
      beforeSave.includes(SECRET)
        ? "the typed value reached localStorage"
        : "nothing in localStorage matches the typed value"
    );

    await saveButton(page).click();
    await savedLine(page).waitFor({ state: "visible", timeout: 5000 });
    record(
      "saving reports the key as stored",
      await savedLine(page).isVisible(),
      await savedLine(page).innerText()
    );

    record(
      "the field is empty again after saving",
      (await field(page).inputValue()) === "",
      `field value is "${await field(page).inputValue()}"`
    );

    const afterSave = await persisted(page);
    record(
      "saving a key does not persist it",
      !afterSave.includes(SECRET),
      afterSave.includes(SECRET)
        ? "the saved value reached localStorage"
        : "nothing in localStorage matches the saved value"
    );

    record(
      "no selected provider carries a secret-named variable",
      !/"?api_key"?\s*:/i.test(afterSave),
      /"?api_key"?\s*:/i.test(afterSave)
        ? `api_key present: ${afterSave.slice(0, 300)}`
        : "no api_key key in any persisted value"
    );

    await page.reload({ waitUntil: "load" });
    await field(page).waitFor({ state: "visible", timeout: 15000 });
    record(
      "the saved state survives a reload, so it came from Rust not from state",
      await savedLine(page).isVisible(),
      "saved line rendered after reload"
    );
    record(
      "a reload still shows no value",
      (await field(page).inputValue()) === "",
      `field value is "${await field(page).inputValue()}"`
    );
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error("secret-field-probe crashed:", error);
  process.exitCode = 1;
});
