const { countryFromIp, currencyForCountry } = require("../src/utils/geo");

// Public IPs with stable, well-known geoip-lite country assignments.
const KNOWN_NG_IP = "105.112.0.1"; // MTN Nigeria block
const KNOWN_US_IP = "8.8.8.8"; // Google DNS, US

describe("geo.countryFromIp", () => {
  it("returns null for missing/empty ip", () => {
    expect(countryFromIp("")).toBeNull();
    expect(countryFromIp(undefined)).toBeNull();
  });

  it("returns null for loopback addresses", () => {
    expect(countryFromIp("127.0.0.1")).toBeNull();
    expect(countryFromIp("::1")).toBeNull();
  });

  it("returns null for private addresses", () => {
    expect(countryFromIp("10.0.0.5")).toBeNull();
    expect(countryFromIp("192.168.1.10")).toBeNull();
    expect(countryFromIp("172.16.0.1")).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(() => countryFromIp("not-an-ip")).not.toThrow();
  });

  it("resolves a known Nigerian IP to NG", () => {
    expect(countryFromIp(KNOWN_NG_IP)).toBe("NG");
  });

  it("resolves a known US IP to US", () => {
    expect(countryFromIp(KNOWN_US_IP)).toBe("US");
  });
});

describe("geo.currencyForCountry", () => {
  it("maps NG to NGN", () => {
    expect(currencyForCountry("NG")).toBe("NGN");
  });

  it("maps any other known country to USD", () => {
    expect(currencyForCountry("US")).toBe("USD");
    expect(currencyForCountry("GB")).toBe("USD");
  });

  it("maps null (unknown) to null, never defaulting to a currency", () => {
    expect(currencyForCountry(null)).toBeNull();
  });
});
