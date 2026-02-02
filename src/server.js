const app = require("./app");
const connectDB = require("./config/db");

// HANDLING UNCAUGHT EXCEPTION
process.on("uncaughtException", (err) => {
  console.log("Unandle Exception... Shutting down");
  console.log(err.name, err.message);
  console.log(err);
  process.exit(1);
});

// Connect to Database
connectDB();

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`Welcome to AppyRight Web Server, Serve is active and running on port ${PORT}`);
});

// HANDLING UNHANDLE PROMISE
process.on("unhandledRejection", (err) => {
  // If we have an error or problem with the database connection, we should go ahead and shut the application
  console.log("Unandle Rejection... Shutting down");
  console.log(err.name, err.message);
  server.close(() => {
    process.exit(1); //And so by doing this, by doing server.close, we give the server, basically time to finish all the reques that are still pending or being handled at the time and only after that, the server is then basicall killed, all right?
  });

  // code 0 = success
  // code 1 = uncaught exception
});
