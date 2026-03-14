const { z } = require("zod");

/**
 * Generic validation middleware that takes a Zod schema
 * and validates the request body, query, and params.
 *
 * @param {Object} schemas - An object containing schemas for body, query, and/or params.
 * @returns {Function} Express middleware function.
 */
const validate = (schemas) => (req, res, next) => {
  try {
    if (schemas.body) {
      req.body = schemas.body.parse(req.body);
    }
    if (schemas.query) {
      req.query = schemas.query.parse(req.query);
    }
    if (schemas.params) {
      req.params = schemas.params.parse(req.params);
    }
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Validation Error",
        errors: error.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
    }
    next(error);
  }
};

module.exports = validate;
