require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const collection = mongoose.connection.collection("users");
  const indexes = await collection.indexes();
  const hasPhoneIndex = indexes.some((i) => i.name === "phone_1");
  if (hasPhoneIndex) {
    await collection.dropIndex("phone_1");
    console.log("Dropped stale phone_1 index.");
  } else {
    console.log("No phone_1 index found — nothing to do.");
  }
  await mongoose.disconnect();
})();
