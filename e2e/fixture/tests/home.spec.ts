import { test, expect } from '@playwright/test';

test('home page shows the shop name', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tiny Shop' })).toBeVisible();
});
