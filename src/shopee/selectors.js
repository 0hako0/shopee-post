export const selectors = {
  loginSignals: [
    'input[type="password"]',
    'text=/log\\s*in|sign\\s*in|ログイン|登入|登录/i'
  ],
  blockSignals: [
    'text=/captcha|verification|two-step|2fa|認証|验证|驗證/i'
  ],
  titleInputs: [
    'input[placeholder*="Product Name" i]',
    'input[placeholder*="商品名" i]',
    'textarea[placeholder*="Product Name" i]',
    '[data-testid*="product-name"] input',
    'input[maxlength="120"]'
  ],
  imageInputs: [
    'input[type="file"][accept*="image"]',
    'input[type="file"]'
  ],
  descriptionInputs: [
    'textarea[placeholder*="Description" i]',
    'textarea[placeholder*="商品説明" i]',
    '[contenteditable="true"]',
    '.ProseMirror'
  ],
  priceInputs: [
    'input[placeholder*="Price" i]',
    'input[placeholder*="価格" i]',
    '[data-testid*="price"] input'
  ],
  stockInputs: [
    'input[placeholder*="Stock" i]',
    'input[placeholder*="在庫" i]',
    '[data-testid*="stock"] input'
  ],
  categoryCandidates: [
    '[data-testid*="category"] li',
    '.category-suggestion li',
    '.shopee-category-suggestion li',
    'li:has-text(">")'
  ],
  attributeRows: [
    '[data-testid*="attribute"]',
    '.product-edit-form-item',
    '.shopee-form-item',
    '.eds-form-item'
  ],
  submitButtons: [
    'button:has-text("Publish")',
    'button:has-text("Update")',
    'button:has-text("投稿")',
    'button:has-text("公開")'
  ]
};
