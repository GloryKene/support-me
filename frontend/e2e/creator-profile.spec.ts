import { test, expect } from '@playwright/test';
import { setupE2EMocks, DEFAULT_MOCK_CREATOR } from './fixtures/test-mocks';

test.describe('Creator Profile Flow', () => {
  test('displays creator details and active donation goals', async ({ page }) => {
    await setupE2EMocks(page);

    // 1. Navigate to Alice's profile
    const response = await page.goto('/alice');
    expect(response?.status()).toBe(200);

    // 2. Creator identity
    await expect(page.getByRole('heading', { level: 1, name: 'Alice Creator' })).toBeVisible();
    await expect(page.getByText('@alice', { exact: true })).toBeVisible();
    await expect(page.getByText(DEFAULT_MOCK_CREATOR.bio)).toBeVisible();

    // 3. Social links
    const twitterLink = page.getByRole('link', { name: 'Twitter' });
    await expect(twitterLink).toBeVisible();
    await expect(twitterLink).toHaveAttribute('href', 'https://twitter.com/alice');

    const githubLink = page.getByRole('link', { name: 'GitHub' });
    await expect(githubLink).toBeVisible();
    await expect(githubLink).toHaveAttribute('href', 'https://github.com/alice');

    // 4. Donation goal progress
    await expect(page.getByText('Community Fund')).toBeVisible();
    await expect(page.getByText('50 / 100 XLM')).toBeVisible();
    const progressbar = page.getByRole('progressbar', { name: 'Community Fund' });
    await expect(progressbar).toBeVisible();
    await expect(progressbar).toHaveAttribute('aria-valuenow', '50');

    // 5. Support card
    await expect(page.getByRole('heading', { name: 'Support Alice Creator' })).toBeVisible();
    await expect(page.getByText('Testnet')).toBeVisible();
  });

  test('displays friendly 404 state when creator does not exist', async ({ page }) => {
    await setupE2EMocks(page);

    // Navigate to a non-existent creator
    const response = await page.goto('/nobody_here');

    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
