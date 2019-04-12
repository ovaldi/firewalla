/*    Copyright 2016 Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require("../net2/logger.js")(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const Block = require('./Block.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const domainBlock = require('../control/DomainBlock.js')();

const exec = require('child-process-promise').exec

const EXPIRE_TIME = 60 * 60 * 48 // one hour

const _ = require('lodash');
const wrapIptables = Block.wrapIptables

const redirectHttpPort = 8880;
const redirectHttpsPort = 8883;
const blackHoleHttpPort = 8881;
const blackHoleHttpsPort = 8884;
const blockHttpPort = 8882;
const blockHttpsPort = 8885;

class CategoryUpdaterBase {

  getCategoryKey(category) {
    return `dynamicCategoryDomain:${category}`
  }

  getExcludeCategoryKey(category) {
    return `category:${category}:exclude:domain`
  }

  getIncludeCategoryKey(category){
    return `category:${category}:include:domain`
  }

  getDefaultCategoryKey(category){
    return `category:${category}:default:domain`
  }

  // this key could be used to store domain, ip, or subnet
  getIPv4CategoryKey(category) {
    return `category:${category}:ip4:domain`
  }

  getIPv6CategoryKey(category) {
    return `category:${category}:ip6:domain`
  }

  async getDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.zrangeAsync(this.getCategoryKey(category), 0, -1)
  }

  async getDefaultDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getDefaultCategoryKey(category))
  }

  async addDefaultDomains(category, domains) {
    if(!this.isActivated(category))
      return []

    if(domains.length === 0) {
      return []
    }

    let commands = [this.getDefaultCategoryKey(category)]

    commands.push.apply(commands, domains)
    return rclient.saddAsync(commands)
  }

  async flushDefaultDomains(category) {
    if(!this.isActivated(category))
      return [];

    return rclient.delAsync(this.getDefaultCategoryKey(category));
  }

  async getIPv4Addresses(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getIPv4CategoryKey(category))
  }

  async getIPv4AddressesCount(category) {
    if(!this.isActivated(category))
      return 0

    return rclient.scardAsync(this.getIPv4CategoryKey(category))
  }

  async addIPv4Addresses(category, addresses) {
    if(!this.isActivated(category))
      return []

    if(addresses.length === 0) {
      return []
    }

    let args = [this.getIPv4CategoryKey(category)]

    args.push.apply(args, addresses)
    return rclient.saddAsync(args)
  }

  async flushIPv4Addresses(category) {
    if(!this.isActivated(category))
      return [];

    return rclient.delAsync(this.getIPv4CategoryKey(category));
  }


  async getIPv6Addresses(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getIPv6CategoryKey(category))
  }

  async getIPv6AddressesCount(category) {
    if(!this.isActivated(category))
      return 0

    return rclient.scardAsync(this.getIPv6CategoryKey(category))
  }

  async addIPv6Addresses(category, addresses) {
    if(!this.isActivated(category))
      return []

    if(addresses.length === 0) {
      return []
    }

    let commands = [this.getIPv6CategoryKey(category)]

    commands.push.apply(commands, addresses)
    return rclient.saddAsync(commands)
  }

  async flushIPv6Addresses(category) {
    if(!this.isActivated(category))
      return [];

    return rclient.delAsync(this.getIPv6CategoryKey(category));
  }


  async getIncludedDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getIncludeCategoryKey(category))
  }

  async addIncludedDomain(category, domain) {
    if(!this.isActivated(category))
      return

    return rclient.saddAsync(this.getIncludeCategoryKey(category), domain)
  }

  async removeIncludedDomain(category, domain) {
    if(!this.isActivated(category))
      return

    return rclient.sremAsync(this.getIncludeCategoryKey(category), domain)
  }

  async getExcludedDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getExcludeCategoryKey(category))
  }

  async addExcludedDomain(category, domain) {
    if(!this.isActivated(category))
      return

    return rclient.saddAsync(this.getExcludeCategoryKey(category), domain)
  }

  async removeExcludedDomain(category, domain) {
    if(!this.isActivated(category))
      return

    return rclient.sremAsync(this.getExcludeCategoryKey(category), domain)
  }

  async includeDomainExists(category, domain) {
    if(!this.isActivated(category))
      return false

    return rclient.sismemberAsync(this.getIncludeCategoryKey(category), domain)
  }

  async excludeDomainExists(category, domain) {
    if(!this.isActivated(category))
      return false

    return rclient.sismemberAsync(this.getExcludeCategoryKey(category), domain)
  }

  async getDomainsWithExpireTime(category) {
    const key = this.getCategoryKey(category)

    const domainAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores')
    const results = []

    for(let i = 0; i < domainAndScores.length; i++) {
      if(i % 2 === 1) {
        const domain = domainAndScores[i-1]
        const score = Number(domainAndScores[i])
        const expireDate = score + EXPIRE_TIME

        results.push({domain: domain, expire: expireDate})
      }
    }

    return results
  }

  async updateDomain(category, domain, isPattern) {

    if(!category || !domain) {
      return;
    }

    if(!this.isActivated(category)) {
      return
    }

    const now = Math.floor(new Date() / 1000)
    const key = this.getCategoryKey(category)

    let d = domain
    if(isPattern) {
      d = `*.${domain}`
    }

    const included = await this.includeDomainExists(category, d);

    if(!included) {
      const excluded = await this.excludeDomainExists(category, d);

      if(excluded) {
        return;
      }
    }

    log.debug(`Found a ${category} domain: ${d}`)

    await rclient.zaddAsync(key, now, d) // use current time as score for zset, it will be used to know when it should be expired out
    await this.updateIPSetByDomain(category, d)
  }

  getIPSetName(category) {
    return Block.getDstSet(category);
  }

  getIPSetNameForIPV6(category) {
    return Block.getDstSet6(category);
  }

  getTempIPSetName(category) {
    return Block.getDstSet(`tmp_${category}`);
  }

  getTempIPSetNameForIPV6(category) {
    return Block.getDstSet6(`tmp_${category}`);
  }

  getDomainMapping(domain) {
    return `rdns:domain:${domain}`
  }

  async getDomainMappingsByDomainPattern(domainPattern) {
    const keys = await rclient.keysAsync(`rdns:domain:${domainPattern}`)
    keys.push(this.getDomainMapping(domainPattern.substring(2)))
    return keys
  }

  getSummedDomainMapping(domain) {
    let d = domain
    if(d.startsWith("*.")) {
      d = d.substring(2)
    }

    return `srdns:pattern:${d}`
  }

  // add entries from category:{category}:ip:domain to ipset
  async updateIPv4Set(category, options) {
    const key = this.getIPv4CategoryKey(category)

    let ipsetName = this.getIPSetName(category)

    if(options && options.useTemp) {
      ipsetName = this.getTempIPSetName(category)
    }

    const hasAny = await rclient.scardAsync(key)

    if(hasAny > 0) {
      let cmd4 = `redis-cli smembers ${key} | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      await exec(cmd4).catch((err) => {
        log.error(`Failed to update ipset by category ${category} with ipv4 addresses, err: ${err}`)
      })
    }
  }

  async updateIPv6Set(category, options) {
    const key = this.getIPv6CategoryKey(category)

    let ipsetName = this.getIPSetNameForIPV6(category)

    if(options && options.useTemp) {
      ipsetName = this.getTempIPSetNameForIPV6(category)
    }

    const hasAny = await rclient.scardAsync(key)

    if(hasAny > 0) {
      let cmd4 = `redis-cli smembers ${key} | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      await exec(cmd4).catch((err) => {
        log.error(`Failed to update ipset by category ${category} with ipv6 addresses, err: ${err}`)
      })
    }
  }

  // use "ipset restore" to add rdns entries to corresponding ipset
  async updateIPSetByDomain(category, domain, options) {
    log.debug(`About to update category ${category} with domain ${domain}, options: ${JSON.stringify(options)}`)

    const mapping = this.getDomainMapping(domain)
    let ipsetName = this.getIPSetName(category)
    let ipset6Name = this.getIPSetNameForIPV6(category)

    if(options && options.useTemp) {
      ipsetName = this.getTempIPSetName(category)
      ipset6Name = this.getTempIPSetNameForIPV6(category)
    }

    if(domain.startsWith("*.")) {
      return this.updateIPSetByDomainPattern(category, domain, options)
    }

    const hasAny = await rclient.zcountAsync(mapping, '-inf', '+inf')

    if(hasAny) {
      let cmd4 = `redis-cli zrange ${mapping} 0 -1 | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      let cmd6 = `redis-cli zrange ${mapping} 0 -1 | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
      await exec(cmd4).catch((err) => {
        log.error(`Failed to update ipset by category ${category} domain ${domain}, err: ${err}`)
      })
      await exec(cmd6).catch((err) => {
        log.error(`Failed to update ipset6 by category ${category} domain ${domain}, err: ${err}`)
      })
    }

  }

  async updateIPSetByDomainPattern(category, domain, options) {
    if(!domain.startsWith("*.")) {
      return
    }

    log.debug(`About to update category ${category} with domain pattern ${domain}, options: ${JSON.stringify(options)}`)

    const mappings = await this.getDomainMappingsByDomainPattern(domain)

    if(mappings.length > 0) {
      const smappings = this.getSummedDomainMapping(domain)
      let array = [smappings, mappings.length]

      array.push.apply(array, mappings)

      await rclient.zunionstoreAsync(array)

      const exists = await rclient.typeAsync(smappings);
      if(exists === "none") {
        return; // if smapping doesn't exist, meaning no ip found for this domain, sometimes true for pre-provided domain list
      }

      await rclient.expireAsync(smappings, 600) // auto expire in 60 seconds

      let ipsetName = this.getIPSetName(category)
      let ipset6Name = this.getIPSetNameForIPV6(category)

      if(options && options.useTemp) {
        ipsetName = this.getTempIPSetName(category)
        ipset6Name = this.getTempIPSetNameForIPV6(category)
      }

      let cmd4 = `redis-cli zrange ${smappings} 0 -1 | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      let cmd6 = `redis-cli zrange ${smappings} 0 -1 | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
      try {
        await exec(cmd4)
        await exec(cmd6)
      } catch(err) {
        log.error(`Failed to update ipset by category ${category} domain pattern ${domain}, err: ${err}`)
      }
    }
  }

  async updatePersistentIPSets(category, options) {
    const ipv4AddressCount = await this.getIPv4AddressesCount(category);
    const ipv6AddressCount = await this.getIPv6AddressesCount(category);

    if(ipv4AddressCount > 0) {
      await this.updateIPv4Set(category, options)
    }

    if(ipv6AddressCount > 0) {
      await this.updateIPv6Set(category, options)
    }
  }

  // rebuild category ipset
  async recycleIPSet(category) {

    await this.updatePersistentIPSets(category, {useTemp: true});

    const domains = await this.getDomains(category)
    const includedDomains = await this.getIncludedDomains(category);
    const defaultDomains = await this.getDefaultDomains(category);
    const excludeDomains = await this.getExcludedDomains(category);

    let dd = _.union(domains, defaultDomains)
    dd = _.difference(dd, excludeDomains)
    dd = _.union(dd, includedDomains)

    for (const domain of dd) {

      let domainSuffix = domain
      if(domainSuffix.startsWith("*.")) {
        domainSuffix = domainSuffix.substring(2);
      }

      const existing = await dnsTool.reverseDNSKeyExists(domainSuffix)
      if(!existing) { // a new domain
        log.info(`Found a new domain with new rdns: ${domainSuffix}`)
        await domainBlock.resolveDomain(domainSuffix)
      }

      await this.updateIPSetByDomain(category, domain, {useTemp: true}).catch((err) => {
        log.error(`Failed to update ipset for domain ${domain}, err: ${err}`)
      })
    }

    await this.swapIpset(category);

    log.info(`Successfully recycled ipset for category ${category}`)
  }

  async swapIpset(category) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)
    const tmpIPSetName = this.getTempIPSetName(category)
    const tmpIPSet6Name = this.getTempIPSetNameForIPV6(category)

    // swap temp ipset with ipset
    const swapCmd = `sudo ipset swap ${ipsetName} ${tmpIPSetName}`
    const swapCmd6 = `sudo ipset swap ${ipset6Name} ${tmpIPSet6Name}`

    await exec(swapCmd).catch((err) => {
      log.error(`Failed to swap ipsets for category ${category}, err: ${err}`)
    })

    await exec(swapCmd6).catch((err) => {
      log.error(`Failed to swap ipsets6 for category ${category}, err: ${err}`)
    })

    const flushCmd = `sudo ipset flush ${tmpIPSetName}`
    const flushCmd6 = `sudo ipset flush ${tmpIPSet6Name}`

    await exec(flushCmd).catch((err) => {
      log.error(`Failed to flush temp ipsets for category ${category}, err: ${err}`)
    })

    await exec(flushCmd6).catch((err) => {
      log.error(`Failed to flush temp ipsets6 for category ${category}, err: ${err}`)
    })
  }

  async deleteCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    return rclient.delAsync(key)
  }

  getCategories() {
    return Object.keys(this.activeCategories)
  }

  async activateCategory(category) {
    await Block.setupCategoryEnv(category);

    this.activeCategories[category] = 1
  }

  async deactivateCategory(category) {
    delete this.activeCategories[category]
    await this.deleteCategoryRecord(category)
  }

  isActivated(category) {
    // always return true for now
    return this.activeCategories[category] !== undefined
  }

  async refreshCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    const date = Math.floor(new Date() / 1000) - EXPIRE_TIME

    return rclient.zremrangebyscoreAsync(key, '-inf', date)
  }

  async refreshAllCategoryRecords() {
    const categories = this.getCategories()

    for (const category of categories) {

      await this.refreshCategoryRecord(category).catch((err) => {
        log.error(`Failed to refresh category ${category}, err: ${err}`)
      }) // refresh domain list for each category

      await this.recycleIPSet(category).catch((err) => {
        log.error(`Failed to recycle ipset for category ${category}, err: ${err}`)
      }) // sync refreshed domain list to ipset
    }
  }

  getHttpPort(category) {
    if(category === 'default_c') {
      return blackHoleHttpPort;
    } else {
      return redirectHttpPort;
    }
  }

  getHttpsPort(category) {
    if(category === 'default_c') {
      return blackHoleHttpsPort;
    } else {
      return redirectHttpsPort;
    }
  }

  async iptablesRedirectCategory(category) {
    try {
      const ipsetName = this.getIPSetName(category)
      const ipset6Name = this.getIPSetNameForIPV6(category)

      const cmdRedirectHTTPRule = wrapIptables(`sudo iptables -w -t nat -I PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`)
      const cmdRedirectHTTPSRule = wrapIptables(`sudo iptables -w -t nat -I PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`)
      const cmdRedirectHTTPRule6 = wrapIptables(`sudo ip6tables -w -t nat -I PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`)
      const cmdRedirectHTTPSRule6 = wrapIptables(`sudo ip6tables -w -t nat -I PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`)

      await exec(cmdRedirectHTTPRule)
      await exec(cmdRedirectHTTPSRule)
      await exec(cmdRedirectHTTPRule6)
      await exec(cmdRedirectHTTPSRule6)
    } catch(err) {
      log.error("Failed to redirect", category, "traffic", err)
    }
  }

  async iptablesUnredirectCategory(category) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    const cmdRedirectHTTPRule = wrapIptables(`sudo iptables -w -t nat -D PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`)
    const cmdRedirectHTTPSRule = wrapIptables(`sudo iptables -w -t nat -D PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`)
    const cmdRedirectHTTPRule6 = wrapIptables(`sudo ip6tables -w -t nat -D PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`)
    const cmdRedirectHTTPSRule6 = wrapIptables(`sudo ip6tables -w -t nat -D PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`)

    await exec(cmdRedirectHTTPRule)
    await exec(cmdRedirectHTTPSRule)
    await exec(cmdRedirectHTTPRule6)
    await exec(cmdRedirectHTTPSRule6)
  }
}

module.exports = CategoryUpdaterBase
