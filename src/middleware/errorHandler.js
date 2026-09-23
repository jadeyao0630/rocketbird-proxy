module.exports = function errorHandler(err, req, res, next) {
  console.error('[error]', err);
  res.status(err.status || 500).json({
    error: err.name || 'ServerError',
    message: err.message || 'Internal Server Error',
  });
};