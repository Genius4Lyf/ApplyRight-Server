const sendWhatsAppOTP = async (phone, otp) => {
    // SIMULATION: In a real app, this would use Twilio, Meta API, etc.
    console.log('=================================================');
    console.log(`[WHATSAPP MOCK] To: ${phone}`);
    console.log(`[WHATSAPP MOCK] Message: Your ApplyRight OTP is: ${otp}`);
    console.log('=================================================');

    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 500));

    return true;
};

module.exports = { sendWhatsAppOTP };
