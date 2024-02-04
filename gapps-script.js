const TOKEN = 'INSERT_YNAB_TOKEN';
const BUDGET_ID = 'INSERT_YNAB_BUDGET_ID;

function parseAmazonEmails() {
  const { transactions } = call_ynab_api('get', `/budgets/${BUDGET_ID}/transactions`) || {};
  if (!transactions) {
    Logger.log('no transactions');
    return;
  }

  const threads = GmailApp.search('from:auto-confirm@amazon.co.uk')

  const updatedTransactions = [];

  for (const thread of threads) {
    const email = thread.getMessages()[0];
    const body = email.getPlainBody();
    const date = email.getDate();

    const ordersRegex = /Ordered item\(s\):([\s\S]+)Order Total: .+(?:(?:EUR (\d+.\d\d))|(?:£(\d+.\d\d)))/gm;

    let totalEuros = 0;
    let totalPounds = 0;
    let currency;
    const items = [];

    let result
    while (result = ordersRegex.exec(body)) {
      let [, order, euros, pounds] = result;

      if (euros) {
        currency = 'EUR';
        euros = parseInt(euros.replace('.', ''));
      } else {
        currency = 'GBP';
        euros = parseInt(pounds.replace('.', '')) * 1.34;
      }
      totalEuros -= euros * 10;

      const itemsRegex = /^ *(?:(\d) x\s+)?(.+?)(?:\s*)$\n.+£(\d+.\d\d)[\s\S]+?Sold by:/gm;
      while (result = itemsRegex.exec(order)) {
        let [, amount, description, pounds] = result;

        amount = +amount || 1;

        pounds = parseInt(pounds.replace('.', ''));
        pounds = amount * pounds;

        totalPounds -= pounds * 10;
        items.push({ amount, description, pounds });
      }
    }

    if (!items.length) {
      if (totalPounds || totalEuros) {
        Logger.log(body);
      }

      continue;
    }

    const possibleTransactions = transactions.filter(transaction => {
      const transactionDate = new Date(transaction.date);

      if (transaction.payee_name !== 'Amazon' || transaction.amount > 0) {
        return false;
      }

      if (
        transactionDate < new Date(date.getFullYear(), date.getMonth(), date.getDate()) ||
        transactionDate > new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7)
      ) {
        return false;
      }

      if (currency === 'EUR' && transaction.amount !== totalEuros) {
        return false;
      }

      if (currency === 'GBP' && Math.abs(transaction.amount + -totalEuros) > 5000) {
        return false;
      }

      return true;
    });

    const transaction = possibleTransactions[0];

    if (!transaction) {
      // Logger.log(`no transaction €${totalEuros} ${date} ${items[0].description}`);
      continue;
    }

    if (transaction.subtransactions.length || (items.length === 1 && transaction.memo)) {
      // already handled
      continue;
    }

    if (currency === 'GBP') {
      totalEuros = transaction.amount;
    }

    const gbpToEur = totalEuros / totalPounds;

    transaction.approved = true;

    if (items.length === 1) {
      transaction.memo = getDescription(items[0], transaction);
    } else {
      transaction.subtransactions = [];

      let total = 0;
      items.forEach((item, i) => {
        const amount = i === items.length - 1 ? transaction.amount - total : Math.round(-item.pounds * 10 * gbpToEur);
        total += amount;

        transaction.subtransactions.push({
          amount,
          payee_id: transaction.payee_id,
          payee_name: transaction.payee_name,
          category_id: transaction.category_id,
          memo: getDescription(item, transaction),
        });
      });
    };

    updatedTransactions.push(transaction);
  }

  call_ynab_api('patch', `/budgets/${BUDGET_ID}/transactions`, { transactions: updatedTransactions });
}

function getDescription(item, _transaction) {
  if (item.amount === 1) {
    return item.description;
  }

  return `${item.amount}x ${item.description}`;
}

function call_ynab_api(method, endpoint, payload = null) {
  var options = {
    'method': method,
    'muteHttpExceptions': true,
    'headers': { 'Authorization': 'Bearer ' + TOKEN }
  }
  if (payload) {
    options['payload'] = JSON.stringify(payload);
    options['headers']["Content-Type"] = "application/json";
  }

  var response = UrlFetchApp.fetch(`https://api.ynab.com/v1${endpoint}`, options);
  var json = response.getContentText();
  return JSON.parse(json).data;
}
