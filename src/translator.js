export class Translator {
  constructor({ targetLanguage }) {
    this.targetLanguage = targetLanguage;
  }

  async translateProduct(product, overrideLanguage) {
    const language = overrideLanguage || this.targetLanguage;
    return {
      title: await this.translateText(product.title, language),
      description: await this.translateText(product.descriptionForListing, language),
      language
    };
  }

  async translateText(text, language) {
    if (!text) return '';
    if (language === 'en') return rewriteEnglish(text);
    if (language === 'zh') return pseudoChineseRewrite(text);
    return text;
  }
}

function rewriteEnglish(text) {
  return String(text)
    .replace(/\bAmazon\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pseudoChineseRewrite(text) {
  return `请人工翻译并确认: ${rewriteEnglish(text)}`;
}
