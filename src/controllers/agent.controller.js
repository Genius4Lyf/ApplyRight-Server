const Client = require("../models/Client");
const DraftCV = require("../models/DraftCV");

// All handlers assume `protect` + `agent` middleware ran, so req.user is an agent.
// Every query is scoped to req.user.id so an agent only ever sees their own data.

// @desc    List the agent's clients (with a CV count each)
// @route   GET /api/agent/clients
// @access  Private (agent)
const listClients = async (req, res) => {
  try {
    const clients = await Client.find({ agentId: req.user.id }).sort({ updatedAt: -1 }).lean();

    // Attach a cvCount per client without an N+1 loop.
    const counts = await DraftCV.aggregate([
      { $match: { clientId: { $in: clients.map((c) => c._id) } } },
      { $group: { _id: "$clientId", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

    res.json(clients.map((c) => ({ ...c, cvCount: countMap.get(String(c._id)) || 0 })));
  } catch (error) {
    console.error("List Clients Error:", error);
    res.status(500).json({ message: "Failed to fetch clients" });
  }
};

// @desc    Create a client
// @route   POST /api/agent/clients
// @access  Private (agent)
const createClient = async (req, res) => {
  try {
    const { name, email, phone, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Client name is required" });
    }

    const client = await Client.create({
      agentId: req.user.id,
      name: name.trim(),
      email: email || "",
      phone: phone || "",
      notes: notes || "",
    });

    res.status(201).json(client);
  } catch (error) {
    console.error("Create Client Error:", error);
    res.status(500).json({ message: "Failed to create client" });
  }
};

// @desc    Get a single client
// @route   GET /api/agent/clients/:id
// @access  Private (agent)
const getClient = async (req, res) => {
  try {
    const client = await Client.findOne({ _id: req.params.id, agentId: req.user.id });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    res.json(client);
  } catch (error) {
    console.error("Get Client Error:", error);
    res.status(500).json({ message: "Failed to fetch client" });
  }
};

// @desc    Update a client
// @route   PATCH /api/agent/clients/:id
// @access  Private (agent)
const updateClient = async (req, res) => {
  try {
    const { name, email, phone, notes } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (notes !== undefined) updates.notes = notes;

    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, agentId: req.user.id },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    res.json(client);
  } catch (error) {
    console.error("Update Client Error:", error);
    res.status(500).json({ message: "Failed to update client" });
  }
};

// @desc    Delete a client (their CVs are kept but unfiled — clientId cleared)
// @route   DELETE /api/agent/clients/:id
// @access  Private (agent)
const deleteClient = async (req, res) => {
  try {
    const client = await Client.findOneAndDelete({ _id: req.params.id, agentId: req.user.id });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    // Unfile the client's CVs rather than deleting the agent's work.
    await DraftCV.updateMany(
      { userId: req.user.id, clientId: client._id },
      { $set: { clientId: null } }
    );
    res.json({ message: "Client deleted" });
  } catch (error) {
    console.error("Delete Client Error:", error);
    res.status(500).json({ message: "Failed to delete client" });
  }
};

// @desc    List the CVs filed under a client
// @route   GET /api/agent/clients/:id/cvs
// @access  Private (agent)
const getClientCVs = async (req, res) => {
  try {
    const client = await Client.findOne({ _id: req.params.id, agentId: req.user.id });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    const cvs = await DraftCV.find({ userId: req.user.id, clientId: client._id }).sort({
      updatedAt: -1,
    });
    res.json(cvs);
  } catch (error) {
    console.error("Get Client CVs Error:", error);
    res.status(500).json({ message: "Failed to fetch client CVs" });
  }
};

// @desc    Dashboard summary counts for the agent
// @route   GET /api/agent/summary
// @access  Private (agent)
const getSummary = async (req, res) => {
  try {
    const [clientCount, cvCount] = await Promise.all([
      Client.countDocuments({ agentId: req.user.id }),
      DraftCV.countDocuments({ userId: req.user.id }),
    ]);
    res.json({ clientCount, cvCount });
  } catch (error) {
    console.error("Agent Summary Error:", error);
    res.status(500).json({ message: "Failed to fetch summary" });
  }
};

module.exports = {
  listClients,
  createClient,
  getClient,
  updateClient,
  deleteClient,
  getClientCVs,
  getSummary,
};
