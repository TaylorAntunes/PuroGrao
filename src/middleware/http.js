function objectBody(req, res, next) {
  if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return res.status(400).json({ error: 'Envie os dados como um objeto JSON.' });
  }
  next();
}

function apiNotFound(req, res) {
  res.status(404).json({ error: 'Recurso não encontrado.' });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Os dados enviados são inválidos.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Os dados enviados excedem o limite permitido.' });
  if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: error.message });
  console.error('Falha ao processar a requisição:', error);
  res.status(500).json({ error: 'Não foi possível concluir a operação. Tente novamente.' });
}

module.exports = { objectBody, apiNotFound, errorHandler };
