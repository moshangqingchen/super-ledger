/** Bank identity only: no account, card number or balance is created by this catalog. */
export const bankCatalog = [
  { id: 'icbc', name: '工商银行', shortName: '工商', color: '#c83338', logo: '/assets/brands/banks/icbc.png' },
  { id: 'ccb', name: '建设银行', shortName: '建设', color: '#2b68ab', logo: '/assets/brands/banks/ccb.ico' },
  { id: 'abc', name: '农业银行', shortName: '农业', color: '#258879', logo: '/assets/brands/banks/abc.ico' },
  { id: 'cmb', name: '招商银行', shortName: '招商', color: '#c73142', logo: '/assets/brands/banks/cmb.ico' },
  { id: 'boc', name: '中国银行', shortName: '中国', color: '#a83249', logo: '/assets/brands/banks/boc.ico' },
  { id: 'bocom', name: '交通银行', shortName: '交通', color: '#345598', logo: '/assets/brands/banks/bocom.ico' },
  { id: 'psbc', name: '邮储银行', shortName: '邮储', color: '#287b63', logo: '/assets/brands/banks/psbc.ico' },
  { id: 'pingan', name: '平安银行', shortName: '平安', color: '#e98b3e', logo: '/assets/brands/banks/pingan.ico' },
];

export const bankById = id => bankCatalog.find(bank => bank.id === id);
