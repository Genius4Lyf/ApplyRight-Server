const swaggerJsDoc = require("swagger-jsdoc");

const swaggerOptions = {
  swaggerDefinition: {
    openapi: "3.0.0",
    info: {
      title: "ApplyRight API Documentation",
      version: "1.0.0",
      description: "AI-driven job application assistant API documentation",
      contact: {
        name: "ApplyRight Support",
      },
      servers: [
        {
          url: process.env.API_URL || "http://localhost:5000",
          description: "Development server",
        },
      ],
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ["./src/routes/*.js", "./src/models/*.js"], // Path to the API docs
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
module.exports = swaggerDocs;
