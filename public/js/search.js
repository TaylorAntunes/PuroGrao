(function (root) {
  const normalize = value => String(value || '').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = value => normalize(value).match(/[a-z0-9]+/g) || [];
  const phonetic = word => word.replace(/y/g, 'i').replace(/ph/g, 'f').replace(/(.)\1+/g, '$1');

  // Adjacent swaps, insertions, deletions and substitutions count as one typo.
  function distance(left, right) {
    const matrix = Array.from({ length: left.length + 1 }, (_, i) => [i]);
    for (let j = 0; j <= right.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= left.length; i++) {
      for (let j = 1; j <= right.length; j++) {
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + Number(left[i - 1] !== right[j - 1]));
        if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
    return matrix[left.length][right.length];
  }

  function matches(product, query) {
    const tokens = words(String(query || '').slice(0, 120));
    const allWords = words(`${product.name} ${product.category || ''} ${product.description || ''}`);
    const fuzzyWords = words(`${product.name} ${product.category || ''}`);
    return tokens.every(token => {
      if (allWords.some(word => word.includes(token))) return true;
      if (token.length < 4) return false;
      const canonical = phonetic(token);
      return fuzzyWords.some(word => {
        if (token.length >= 5 && canonical === phonetic(word)) return true;
        const limit = token.length >= 7 && word.length >= 7 ? 2 : 1;
        return Math.abs(token.length - word.length) <= limit && distance(token, word) <= limit;
      });
    });
  }

  const search = { matches };
  if (typeof module === 'object' && module.exports) module.exports = search;
  else root.ProductSearch = search;
})(globalThis);
