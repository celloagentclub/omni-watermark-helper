const keyPair = await crypto.subtle.generateKey(
  {
    name: 'ECDSA',
    namedCurve: 'P-256'
  },
  true,
  ['sign', 'verify']
);

const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

console.log('LICENSE_PRIVATE_JWK=');
console.log(JSON.stringify(privateJwk));
console.log('\nLICENSE_PUBLIC_JWK=');
console.log(JSON.stringify(publicJwk));
