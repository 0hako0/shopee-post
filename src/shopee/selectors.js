export const selectors = {
  loginSignals: [
    'input[type="password"]',
    'text=/log\\s*in|sign\\s*in/i'
  ],
  blockSignals: [
    'text=/captcha|verification|two-step|2fa|verification code/i'
  ],
  titleInputs: [
    'input[placeholder*="Product Name" i]',
    'input[placeholder*="Brand Name" i]',
    'input[placeholder*="Product Type" i]',
    'input[placeholder*="Key Features" i]',
    'textarea[placeholder*="Product Name" i]',
    '[data-testid*="product-name"] input',
    'input[maxlength="255"]',
    'input[maxlength="120"]'
  ],
  imageInputs: [
    'input[type="file"][accept*="image"]',
    'input[type="file"]'
  ],
  imageUploadTriggers: [
    'text=/Add Image/i',
    'text=/Add image/i',
    '[class*="image"]:has-text("Add")',
    '[class*="upload"]:has-text("Add")'
  ],
  categoryFields: [
    'input[placeholder*="category" i]',
    'input[placeholder*="Please set category" i]',
    'text=/Please set category/i',
    '[class*="category"] input',
    '[class*="category"]:has-text("Please set category")'
  ],
  categoryCandidates: [
    '[role="option"]',
    '[class*="option"]:visible',
    '[class*="category"] li:visible',
    '[class*="popover"] li:visible',
    '[class*="dropdown"] li:visible',
    'li:has-text(">")'
  ],
  categoryConfirmButtons: [
    'button:has-text("Confirm")',
    'button:has-text("Apply")',
    'button:has-text("Save")',
    'button:has-text("OK")'
  ],
  descriptionInputs: [
    'textarea[placeholder*="Description" i]',
    'textarea[placeholder*="Product Description" i]',
    '[contenteditable="true"]',
    '.ProseMirror'
  ],
  priceInputs: [
    'input[placeholder*="Price" i]',
    'input[placeholder*="Original Price" i]',
    '[data-testid*="price"] input',
    '[class*="price"] input'
  ],
  stockInputs: [
    'input[placeholder*="Stock" i]',
    'input[placeholder*="Available Stock" i]',
    '[data-testid*="stock"] input',
    '[class*="stock"] input'
  ],
  attributeRows: [
    '[data-testid*="attribute"]',
    '.product-edit-form-item',
    '.shopee-form-item',
    '.eds-form-item',
    '[class*="form-item"]'
  ],
  submitButtons: [
    'button:has-text("Publish")',
    'button:has-text("Update")',
    'button:has-text("Save and Publish")'
  ]
};
