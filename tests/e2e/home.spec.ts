// The home spec is the canary: if the export stops booting, every other check here is noise.
import { expect, type Page, test } from '@playwright/test';

declare global {
  interface Window {
    proofWorkerProbe: {
      created: number;
      terminated: number[];
      hasProof: boolean;
      flush: () => void;
    };
  }
}

test('homepage hydrates and proves in a worker under the deployed path', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("worker-src 'self'");

  await expect(
    page.getByRole('heading', { level: 1, name: /write a claim, prove it, try to cheat/i }),
  ).toBeVisible();
  await expect(page.getByLabel('Claim and proving controls')).toBeVisible();
  await expect(page.getByLabel('Workshop workbench')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pythagorean', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Prove Selected Claim' }).click();
  await expect(page.getByText(/proof generated in a worker and verified locally/i)).toBeVisible();
  await page.getByRole('button', { name: '15', exact: true }).click();
  await expect(page.getByText(/^pass —/)).toHaveCount(7);

  expect(pageErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test('proof artifacts expire on public input edits and verified files preserve the URL', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Pythagorean', exact: true }).click();
  await page.getByRole('button', { name: 'Prove Selected Claim' }).click();
  await expect(page.getByRole('button', { name: 'Share Proof' })).toBeEnabled();
  const address = page.url();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download public proof' }).click(),
  ]);
  expect(page.url()).toBe(address);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  expect(bytes.toString()).toMatch(/^#p(u)?=[A-Za-z0-9_-]+$/);
  await page.getByLabel('c (public)', { exact: true }).fill('6');
  await expect(page.getByRole('button', { name: 'Share Proof' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download public proof' })).toBeDisabled();
  await page
    .getByLabel('Import public proof')
    .setInputFiles({ name: download.suggestedFilename(), mimeType: 'text/plain', buffer: bytes });
  await expect(page.getByText(/Verified public proof imported/)).toBeVisible();
  expect(page.url()).toBe(address);
  // Delay an older valid selection, then reject a newer one. The older read
  // must not overwrite the current workspace or its rejection.
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    let release: (() => void) | undefined;
    Object.assign(window, { releaseProofFile: () => release?.() });
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'held.txt') return read.call(this);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        release = () => {
          void read.call(this).then(resolve, reject);
        };
      });
    };
  });
  await page.getByLabel('Import public proof').setInputFiles({
    name: 'held.txt',
    mimeType: 'text/plain',
    buffer: bytes,
  });
  await page.getByLabel('Import public proof').setInputFiles({
    name: 'bad.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(bytes.toString() + '\n'),
  });
  await expect(
    page.getByText('share URL needs a #p= or #pu= payload', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { releaseProofFile: () => void }).releaseProofFile(),
  );
  await page.waitForTimeout(500);
  await expect(
    page.getByText('share URL needs a #p= or #pu= payload', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download public proof' })).toBeEnabled();
  expect(page.url()).toBe(address);
});

async function holdFirstWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const held: (() => void)[] = [];
    const probe = {
      created: 0,
      terminated: [] as number[],
      hasProof: false,
      flush: () => held.splice(0).forEach((deliver) => deliver()),
    };
    Object.assign(window, { proofWorkerProbe: probe });
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const index = probe.created++;
        probe.terminated[index] = 0;
        const listeners = new Map<EventListenerOrEventListenerObject, EventListener>();
        return new Proxy(worker, {
          get(targetWorker, property) {
            if (property === 'terminate')
              return () => {
                probe.terminated[index]! += 1;
                targetWorker.terminate();
              };
            if (property === 'addEventListener')
              return (type: string, listener: EventListenerOrEventListenerObject) => {
                if (type !== 'message' || index !== 0) {
                  targetWorker.addEventListener(type, listener);
                  return;
                }
                const deliver = (event: Event) => {
                  if (typeof listener === 'function') listener.call(targetWorker, event);
                  else listener.handleEvent(event);
                };
                const wrapped = (event: Event) => {
                  const data = (event as MessageEvent).data;
                  if (data?.kind === 'proof') {
                    probe.hasProof = true;
                    // Retain the already queued callbacks even after listener removal.
                    // This forces late success, progress and error through the client's guard.
                    held.push(() =>
                      deliver(
                        new MessageEvent('message', {
                          data: { id: 1, kind: 'progress', stage: 'obsolete progress' },
                        }),
                      ),
                    );
                    held.push(() =>
                      deliver(
                        new MessageEvent('message', {
                          data: { id: 1, kind: 'error', message: 'obsolete error' },
                        }),
                      ),
                    );
                  }
                  held.push(() => deliver(event));
                };
                listeners.set(listener, wrapped);
                targetWorker.addEventListener(type, wrapped);
              };
            if (property === 'removeEventListener')
              return (type: string, listener: EventListenerOrEventListenerObject) =>
                targetWorker.removeEventListener(type, listeners.get(listener) ?? listener);
            const value = Reflect.get(targetWorker, property, targetWorker);
            return typeof value === 'function' ? value.bind(targetWorker) : value;
          },
        });
      },
    });
  });
}

for (const replacement of ['cancel', 'preset', 'public input'] as const) {
  test(`a ${replacement} replacement ignores late worker callbacks and permits a fresh proof`, async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await holdFirstWorker(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Pythagorean', exact: true }).click();
    await page.getByRole('button', { name: 'Prove Selected Claim' }).evaluate((button) => {
      // Attempt repeated activation in one task; only one worker may start.
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => window.proofWorkerProbe.hasProof);
    expect(await page.evaluate(() => window.proofWorkerProbe.created)).toBe(1);
    if (replacement === 'cancel') {
      await page.getByRole('button', { name: 'Cancel proving' }).click();
      await expect(page.getByText(/Cancelled. No proof was accepted/)).toBeVisible();
    } else if (replacement === 'preset') {
      await page.getByRole('button', { name: 'Age ≥ 18', exact: true }).click();
      await expect(page.getByRole('slider', { name: 'age', exact: true })).toBeVisible();
    } else {
      await page.getByLabel('c (public)', { exact: true }).fill('6');
    }
    await page.evaluate(() => window.proofWorkerProbe.flush());
    await expect(page.getByRole('button', { name: 'Share Proof' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Download public proof' })).toBeDisabled();
    await expect(page.getByText(/obsolete progress|obsolete error/)).toHaveCount(0);
    await expect(page.getByText(/proof generated in a worker and verified locally/i)).toHaveCount(
      0,
    );
    expect(await page.evaluate(() => window.proofWorkerProbe.terminated)).toEqual([1]);
    if (replacement === 'public input')
      await page.getByLabel('c (public)', { exact: true }).fill('5');
    await page.getByRole('button', { name: 'Prove Selected Claim' }).click();
    await expect(page.getByRole('button', { name: 'Share Proof' })).toBeEnabled();
    expect(await page.evaluate(() => window.proofWorkerProbe.terminated)).toEqual([1, 1]);
    expect(pageErrors).toEqual([]);
  });
}
