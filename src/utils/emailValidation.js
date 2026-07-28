// Same general format+TLD regex previously duplicated verbatim in
// auth.controller.js and models/User.js — consolidated here so there's one
// place to change instead of two copies drifting apart.
const GENERAL_EMAIL_REGEX =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(com|org|net|edu|gov|mil|co|io|ai|tech|dev|app|uk|ca|au|de|fr|jp|cn|in|br|mx|es|it|nl|se|no|dk|fi|ch|at|be|ie|nz|sg|hk|my|ph|th|vn|id|kr|tw|za|ae|sa|eg|ng|ke|gh|tz|ug|zm|zw|bw|mw|na|sz|ls|gm|sl|lr|sn|ml|bf|ne|td|cf|cm|ga|cg|cd|ao|mz|mg|sc|mu|re|yt|km|dj|so|et|er|sd|ss|ly|tn|dz|ma|eh|mr|cv|st|gq|gw|bi|rw|vu|fj|pg|sb|nc|pf|ws|to|tv|ki|nr|fm|mh|pw|mp|gu|as|vi|pr|do|jm|tt|bb|gd|lc|vc|ag|kn|dm|bs|ky|bm|tc|vg|ai|ms|gl|fo|is|li|mc|sm|va|ad|mt|cy|tr|gr|bg|ro|hu|cz|sk|pl|ua|by|ru|lt|lv|ee|md|ge|am|az|kz|uz|tm|kg|tj|mn|kp|mm|la|kh|bn|mv|bt|np|lk|bd|pk|af|ir|iq|sy|lb|jo|il|ps|ye|om|kw|bh|qa|info|biz|name|pro|coop|aero|museum|travel|jobs|mobi|tel|xxx|asia|cat|post|xxx)$/i;

const GMAIL_DOMAIN_RE = /@(gmail|googlemail)\.com$/i;

// Google's own signup rules for the LOCAL part of a Gmail address: 6-30 chars,
// letters/numbers/dots only, no leading/trailing dot, no consecutive dots. A
// "+tag" suffix is Gmail's own alias mechanism for receiving mail (e.g.
// name+jobsite@gmail.com) — allowed, doesn't count toward the 6-30 length, and
// is only checked for stray invalid characters, not the stricter base rules.
const isPlausibleGmailLocalPart = (localPart) => {
  const [base, ...tagParts] = localPart.split("+");
  const tag = tagParts.join("+");
  if (tag && !/^[a-zA-Z0-9.]*$/.test(tag)) return false;
  if (base.length < 6 || base.length > 30) return false;
  if (!/^[a-zA-Z0-9](\.?[a-zA-Z0-9])*$/.test(base)) return false;
  return true;
};

// Returns { ok, message } — message is only meaningful when ok is false, and
// is specific to WHICH rule failed (generic format vs. Gmail-specific) so the
// user understands why.
const validateRegistrationEmail = (email) => {
  const v = String(email || "").trim();
  if (!GENERAL_EMAIL_REGEX.test(v)) {
    return {
      ok: false,
      message:
        "Please enter a valid email address with a recognized domain (e.g., @gmail.com, @outlook.com, @company.com)",
    };
  }
  if (GMAIL_DOMAIN_RE.test(v)) {
    const [localPart] = v.split("@");
    if (!isPlausibleGmailLocalPart(localPart)) {
      return {
        ok: false,
        message:
          "That doesn't look like a real Gmail address. Gmail usernames are 6-30 characters and use only letters, numbers, and dots.",
      };
    }
  }
  return { ok: true };
};

module.exports = { validateRegistrationEmail, GENERAL_EMAIL_REGEX, GMAIL_DOMAIN_RE };
