import { expect, type Page, test } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@outcomes.ai";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "Admin@123";

async function signIn(page: Page) {
  await page.goto("/login");
  await submitCredentials(page);
  const navigated = await page.waitForURL(/\/tasks/, { timeout: 30_000 }).then(
    () => true,
    () => false
  );
  if (!navigated && (await page.getByRole("button", { name: "Sign In" }).isVisible())) {
    await submitCredentials(page);
    await page.waitForURL(/\/tasks/, { timeout: 30_000 });
  }
  await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible({ timeout: 30_000 });
  const acknowledgement = page.getByRole("dialog", { name: "Confidentiality acknowledgement" });
  if (await acknowledgement.isVisible().catch(() => false)) {
    await acknowledgement
      .getByRole("checkbox", {
        name: "I understand and will handle all annotation data only inside the approved workflow.",
      })
      .check();
    await acknowledgement.getByRole("button", { name: "Accept and continue" }).click();
    await expect(acknowledgement).toBeHidden();
  }
}

async function submitCredentials(page: Page) {
  await page.getByLabel("Work Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
}

test.describe("outcomes.ai speech annotator core flows", () => {
  test("admin can sign in and open upload page", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Admin Upload" }).click();
    await expect(page.getByText("Upload Annotation Jobs")).toBeVisible();
  });

  test("admin can open metrics page", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Metrics" }).click();
    await expect(page.getByRole("heading", { name: "Quality and Productivity Dashboard" })).toBeVisible();
    await expect(page.getByText("Model Accuracy")).toBeVisible();
    await expect(page.getByText("PII Label Management")).toBeVisible();
  });

  test("annotator task workspace shows transcript panels", async ({ page }) => {
    test.skip(!process.env.E2E_RUN_TASK_FLOW, "Task flow needs seeded tasks and credentials in CI env.");
    await signIn(page);
    await page.goto("/tasks");
    await page.getByRole("link", { name: "Open" }).first().click();
    await expect(page.getByText("ASR Transcript Comparison")).toBeVisible();
    await expect(page.getByLabel("Final Transcript")).toBeVisible();
  });

  test("pii panel adds labels from selected transcript text", async ({ page }) => {
    test.skip(!process.env.E2E_RUN_TASK_FLOW, "Task flow needs seeded tasks and credentials in CI env.");
    await signIn(page);
    await page.goto("/tasks");
    await page.getByRole("link", { name: "Open" }).first().click();
    await page.getByLabel("Final Transcript").fill("Reach me at 1234567890");
    await page.getByRole("button", { name: "Open PII Panel" }).click();

    const transcriptSurface = page.getByLabel("Selectable transcript for PII");
    await expect(transcriptSurface).toBeVisible();
    await expect(page.locator('input[type="range"]')).toHaveCount(0);
    await transcriptSurface.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode && !textNode.textContent?.includes("1234567890")) {
        textNode = walker.nextNode();
      }
      if (!textNode?.textContent) {
        throw new Error("Expected selectable phone number text");
      }
      const start = textNode.textContent.indexOf("1234567890");
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + "1234567890".length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    await page.getByLabel("New PII label").selectOption("PHONE");
    await page.getByRole("button", { name: "Add Selection" }).click();
    await expect(page.getByLabel("PII value for PHONE")).toHaveValue("1234567890");
  });
});
