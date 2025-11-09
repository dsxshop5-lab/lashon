// test-webhook.js
const axios = require('axios');

(async () => {
  const url = process.env.URL || 'http://localhost:3000/webhook/gumroad';
  const sample = {
    sale_id: 'sale_12345',
    email: 'user@example.com',
    full_name: 'Test Buyer',
    product_name: 'Lashon Captions',
    price: 9900,
    currency: 'ILS',
    custom_fields: { phone: '+972534372335' }
  };
  const { data, status } = await axios.post(url, sample, {
    headers: { 'Content-Type': 'application/json' }
  });
  console.log('STATUS', status);
  console.log('DATA', data);
})();
