exports.up = (pgm) => {
  // Existing sessions cannot prove which company restrictions created them.
  // An empty scope makes them unusable until the user signs in again.
  pgm.addColumn('customer_sessions', {
    auth_scope: { type: 'text', notNull: true, default: '' },
  });
  pgm.addColumn('customer_login_requests', {
    auth_scope: { type: 'text', notNull: true, default: '' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('customer_login_requests', 'auth_scope');
  pgm.dropColumn('customer_sessions', 'auth_scope');
};
