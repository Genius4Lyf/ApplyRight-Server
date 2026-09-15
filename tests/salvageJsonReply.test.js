// PULLING A USABLE REPLY OUT OF A HALF-WRITTEN JSON OBJECT.
//
// This exists because of a real, user-visible failure: a model ran out of budget mid-object
// and the controller, unable to tell "truncated JSON" from "prose without a wrapper",
// handed the fragment to the user as Aria's message. They read
// `{"reply":"That's an excellent example! ...` in the chat.
const { salvageJsonReply, looksLikeJsonObject } = require("../src/utils/salvageJsonReply");

describe("looksLikeJsonObject — the structural guard", () => {
  it("recognises a serialized object, whole or truncated", () => {
    expect(looksLikeJsonObject('{"reply":"hello","intent":"building"}')).toBe(true);
    expect(looksLikeJsonObject('{"reply":"hello","description":"1. Carried out rout')).toBe(true);
    expect(looksLikeJsonObject('  \n {"reply":"padded"}')).toBe(true);
  });

  it("does not mistake prose for an object", () => {
    // The whole point: case (a) — a model answering in plain text — must still be
    // delivered to the user, so it must not trip this.
    expect(looksLikeJsonObject("That's an excellent example! Here's how we can use it.")).toBe(
      false
    );
    expect(looksLikeJsonObject("")).toBe(false);
    expect(looksLikeJsonObject(null)).toBe(false);
  });

  it("is not fooled by prose that merely opens with a brace", () => {
    expect(looksLikeJsonObject("{ this is not json at all }")).toBe(false);
    expect(looksLikeJsonObject("{")).toBe(false);
  });
});

describe("salvaging the reply", () => {
  it("recovers the reply from an object cut off mid-way through a LATER key", () => {
    // The common shape: `reply` is the first key the prompt asks for, so it is complete
    // even when everything after it was lost.
    const raw =
      '{"reply":"That\'s an excellent example! Here is how we can put it on your CV.","intent":"ready","description":"1. Carried out routine maintenance on a diesel engine, identi';
    expect(salvageJsonReply(raw)).toBe(
      "That's an excellent example! Here is how we can put it on your CV."
    );
  });

  it("recovers a reply that was ITSELF cut off", () => {
    const raw = '{"reply":"Now, let us compile everything we have gathered for your CV bu';
    expect(salvageJsonReply(raw)).toBe(
      "Now, let us compile everything we have gathered for your CV bu"
    );
  });

  it("decodes the escapes that carry Aria's formatting", () => {
    // `reply` is markdown: newlines and bullets are how it reads as anything but a wall of
    // text, and they arrive escaped inside the JSON string.
    const raw = '{"reply":"Here you go:\\n\\n- First thing\\n- Second thing","intent":"bui';
    expect(salvageJsonReply(raw)).toBe("Here you go:\n\n- First thing\n- Second thing");
  });

  it("handles an escaped quote without ending the string early", () => {
    const raw = '{"reply":"She said \\"yes\\" to the offer","intent":"buil';
    expect(salvageJsonReply(raw)).toBe('She said "yes" to the offer');
  });

  it("handles a unicode escape", () => {
    expect(salvageJsonReply('{"reply":"caf\\u00e9 work","intent":"bui')).toBe("café work");
  });

  it("stops cleanly when the buffer dies mid-escape", () => {
    // A trailing lone backslash must not become part of the reply.
    expect(salvageJsonReply('{"reply":"almost there\\')).toBe("almost there");
    expect(salvageJsonReply('{"reply":"caf\\u00')).toBe("caf");
  });

  it("returns nothing for prose, so the caller falls back to its own copy", () => {
    expect(salvageJsonReply("That's an excellent example!")).toBe("");
    expect(salvageJsonReply("")).toBe("");
  });

  it("returns nothing when the object has no reply key", () => {
    expect(salvageJsonReply('{"intent":"ready","description":"1. Carried out"')).toBe("");
  });

  it("returns nothing when reply is not a string", () => {
    // Guessing at a non-string value would be inventing a message.
    expect(salvageJsonReply('{"reply":null,"intent":"ready"')).toBe("");
    expect(salvageJsonReply('{"reply":["a","b"]')).toBe("");
  });

  it("reads a complete object as happily as a broken one", () => {
    expect(salvageJsonReply('{"reply":"All fine here.","intent":"building"}')).toBe(
      "All fine here."
    );
  });

  it("is not confused by the word reply appearing inside the reply", () => {
    const raw = '{"reply":"I will reply to that: \\"reply\\" is a normal word.","intent":"a';
    expect(salvageJsonReply(raw)).toBe('I will reply to that: "reply" is a normal word.');
  });

  it("can recover another named field when asked", () => {
    const raw = '{"reply":"hi","description":"1. Did the thing","intent":"rea';
    expect(salvageJsonReply(raw, "description")).toBe("1. Did the thing");
  });
});
