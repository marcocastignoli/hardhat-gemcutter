const { info } = require('console');
const fs = require("fs");
const { promises } = fs
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { runTypeChain, glob } = require('typechain')


const { getSelectors, FacetCutAction, getSelector } = require('./lib/diamond.js')
const DiamondDifferentiator = require('./lib/DiamondDifferentiator.js')
const {
  loupe,
  verify,
  createDiamondFileFromSources,
  getDiamondJson,
  setDiamondJson,
  getFunctionsNamesSelectorsFromFacet,
  getAddressFromArgs,
  getChainIdByNetworkName,
  getABIsFromArtifacts,
  getMetadataFromAddress,
  getFunctionSelectorFromAbi
} = require('./lib/utils.js')

async function runCommands(commands, file) {
  for (let i = 0; i<commands.length; i++) {
      let command = `${commands[i]} --o ${file}`
      try {
          console.log(command)
          const {stdout} = await exec(command)
          console.log(stdout)
      } catch(e) {
          if (e.toString().includes('HH108')) {
              console.error('You need to run the development environment first, try running: yarn dev:start in another terminal before running this command.')
              process.exit(1)
          } else {
              console.log(e.toString())
          }
      }
  }
}

require('dotenv').config();

task("diamond:deploy", "Deploy a new diamond")
  .addOptionalParam("o", "The diamond file to deploy", "diamond.json")
  .addOptionalParam("diamondCutFacet", "The standard address of the cut facet", "0xB6907D091130B62fe67D65bA322a75ef27668bfC")
  .addOptionalParam("diamondInit", "The standard address of the init facet", "0x79B6775d20feF47F8613434f350399B8cC8f7709")
  .addOptionalParam("diamondLoupeFacet", "The standard address of the init facet", "0x710A769bbE329Fa239D02B8dF5c964B1e8C27111")
  .addOptionalParam("ownershipFacet", "The standard address of the init facet", "0x942c510681F16E286b4166D9bcEbbB5ae5e6654E")
  .setAction(async (args, hre) => {
    const CHAIN_ID = getChainIdByNetworkName(hre.config.defaultNetwork)

    await hre.run("clean")
    await hre.run("compile")
    
    console.log(`Deploying Diamond...`)
    let contractsToVerify = []

    let diamondJson = {
      functionSelectors: {},
      contracts: {},
    }

    const accounts = await ethers.getSigners()
    const contractOwner = accounts[0]

    // deploy DiamondCutFacet
    let diamondCutFacetAddress
    if (args.diamondCutFacet === '') {
      const DiamondCutFacet = await ethers.getContractFactory('DiamondCutFacet')
      const diamondCutFacet = await DiamondCutFacet.deploy()
      diamondCutFacetAddress = diamondCutFacet.address
      await diamondCutFacet.deployed()

      contractsToVerify.push({
        name: 'DiamondCutFacet',
        address: diamondCutFacetAddress
      })
    } else {
      diamondCutFacetAddress = args.diamondCutFacet
    }

    let diamondLoupeFacetAddress
    if (args.diamondLoupeFacet === '') {
      const DiamondLoupeFacet = await ethers.getContractFactory('DiamondLoupeFacet')
      const diamondLoupeFacet = await DiamondLoupeFacet.deploy()
      diamondLoupeFacetAddress = diamondLoupeFacet.address
      await diamondLoupeFacet.deployed()
  
      contractsToVerify.push({
        name: 'DiamondLoupeFacet',
        address: diamondLoupeFacetAddress
      })
    } else {
      diamondLoupeFacetAddress = args.diamondLoupeFacet
    }

    // deploy Diamond
    const Diamond = await ethers.getContractFactory('Diamond')
    const diamond = await Diamond.deploy(contractOwner.address, diamondCutFacetAddress, diamondLoupeFacetAddress)
    await diamond.deployed()

    contractsToVerify.push({
      name: 'Diamond',
      address: diamond.address
    })
    
    let diamondInit
    let diamondInitAddress = ''
    if (args.diamondInit === '') {
      const DiamondInit = await ethers.getContractFactory('DiamondInit')
      diamondInit = await DiamondInit.deploy()
      await diamondInit.deployed()

      diamondJson.contracts.DiamondInit = {
        "name": "DiamondInit",
        "address": diamondInit.address,
        "type": "remote"
      }
      contractsToVerify.push({
        name: 'DiamondInit',
        address: diamondInit.address
      })
      diamondInitAddress = diamondInit.address
    } else {
      diamondInitAddress = args.diamondInit
    }

    diamondJson.type = 'remote'
    diamondJson.address = diamond.address
    await setDiamondJson(diamondJson, args.o)

    console.log(`[OK] Diamond deployed at address: ${diamond.address}`)

    let ownershipFacetAddress
    if (args.ownershipFacet === '') {
      const OwnershipFacet = await ethers.getContractFactory('OwnershipFacet')
      const ownershipFacet = await OwnershipFacet.deploy()
      ownershipFacetAddress = ownershipFacet.address
      await ownershipFacet.deployed()
  
      contractsToVerify.push({
        name: 'OwnershipFacet',
        address: ownershipFacetAddress
      })
    } else {
      ownershipFacetAddress = args.ownershipFacet
    }
    
    const res = await verify(contractsToVerify)
    
    console.log('[OK] Diamond verified')


    await hre.run('diamond:add', {
      o: args.o,
      remote: true,
      address: diamondCutFacetAddress
    })
    await hre.run('diamond:add', {
      o: args.o,
      remote: true,
      address: diamondInitAddress
    })

    console.log('Adding Loupe Facet...')
    await hre.run('diamond:add', {
      o: args.o,
      remote: true,
      address: diamondLoupeFacetAddress
    })

    console.log('Adding Ownership Facet...')
    await hre.run('diamond:add', {
      o: args.o,
      remote: true,
      address: ownershipFacetAddress
    })

    await hre.run('diamond:cut', {
      o: args.o
    })

    console.log(`[OK] Diamond cut complete`)

  })

task("diamond:status", "Compare the local diamond.json with the remote diamond")
  .addOptionalParam("address", "The diamond's address", "")
  .addOptionalParam("o", "The file to create", "diamond.json")
  .setAction(async (args) => {
    const CHAIN_ID = getChainIdByNetworkName(hre.config.defaultNetwork)
    let address = await getAddressFromArgs(args)

    let output1 = await loupe(address, CHAIN_ID)

    let output2 = await getDiamondJson(args.o)

    const differentiator = new DiamondDifferentiator(output1, output2)

    console.log('\nDiamonds:')
    console.log('\tAdd: ', differentiator.getFunctionsFacetsToAdd())
    console.log('\tRemove: ', differentiator.getFunctionsFacetsToRemove())
    console.log('\tReplace: ', differentiator.getFunctionFacetsToReplace())
    console.log('\nContracts to deploy:')
    console.log(differentiator.getContractsToDeploy())
  });


task("diamond:add", "Adds or replace facets and functions to diamond.json")
  .addFlag("remote", "Add remote facet")
  .addFlag("local", "Add local facet")
  .addOptionalParam("o", "The diamond file to output to", "diamond.json")
  .addOptionalParam("address", "The address of the remote facet to add")
  .addOptionalParam("name", "The name of the local facet to add")
  .addOptionalParam("links", "Libraries to link", "")
  .addFlag("skipFunctions", "Only add contract")
  .addFlag("saveMetadata", "Save the metadata of the added facet")
  .setAction(
  async (args, hre) => {
    const CHAIN_ID = getChainIdByNetworkName(hre.config.defaultNetwork)
    if (args.remote && args.local) {
      return console.log('remote or local, not both')
    }
    const diamondJson = await getDiamondJson(args.o)
    if (args.remote) {

      const {abi, name, output} = await getMetadataFromAddress(args.address)

      // return
      diamondJson.contracts[name] = {
        name,
        address: args.address,
        type: "remote"
      }
      if (!args.skipFunctions) {
        for(let obj of abi) {
          if (obj.type === 'function') {
            diamondJson.functionSelectors[getFunctionSelectorFromAbi(obj)] = name
          }
        }
      }
      await setDiamondJson(diamondJson, args.o)
      console.log(`[OK] Add facet ${name} to ${args.o}`)

      if (args.saveMetadata) {
        await promises.writeFile(`./metadata/${name}.json`, JSON.stringify(output))
      }

    } else if (args.local) {

      await hre.run("clean")
      await hre.run("compile")

      const ABIs = await getABIsFromArtifacts()

      const FacetName = args.name

      const functionSelectors = {}
      ABIs[FacetName].filter(el => el.type==='function').forEach(el => {
        functionSelectors[getFunctionSelectorFromAbi(el)] = FacetName
      })
      
      diamondJson.contracts[FacetName] = {
        "name": FacetName,
        "type": "local"
      }

      const links = args.links.split(',').filter(link => link != "")
      if (links.length>0) {
        diamondJson.contracts[FacetName].links = links
      }

      diamondJson.functionSelectors = {...diamondJson.functionSelectors, ...functionSelectors}

      console.log(`[OK] Add facet ${FacetName} to ${args.o}`)
      await setDiamondJson(diamondJson, args.o)
    }
  });

// diamond:remove
task("diamond:remove", "Remove facets and functions to diamond.json")
  .addOptionalParam("o", "The diamond file to output to", "diamond.json")
  .addOptionalParam("name", "The name of the local facet to add")
  .setAction(
  async (args, hre) => {
    const FacetName = args.name
    const diamondJson = await getDiamondJson(args.o)
    
    let newFunctionSelectors = {}
    for (let fn in diamondJson.functionSelectors) {
      let facet = diamondJson.functionSelectors[fn]
      if (facet != FacetName) {
        newFunctionSelectors[fn] = facet
      }
    }
    diamondJson.functionSelectors = newFunctionSelectors
    console.log(`[OK] Remove facet ${FacetName} from ${args.o}`)
    await setDiamondJson(diamondJson, args.o)
  });

// diamond:replace

async function deployAndVerifyFacetsFromDiff(facetsToDeployAndVerify, CHAIN_ID) {
  /**@notice deploy new facets */
  if (facetsToDeployAndVerify.length === 0) {
    []
  }
  console.log('Deploying facets...')
  let contracts = []
  for (const contract of facetsToDeployAndVerify) {
    const FacetName = contract.name
    let Facet
    if (contract.links) {
      const libraries = {}
      for (let link of contract.links) {
        let Link = await ethers.getContractFactory(link)
        const linkDeployed = await Link.deploy()
        libraries[link] = linkDeployed.address
      }
      Facet = await ethers.getContractFactory(FacetName, { libraries })
    } else {
      Facet = await ethers.getContractFactory(FacetName)
    }
    const facet = await Facet.deploy()
    await facet.deployed()
    contracts.push({
      name: contract.name,
      address: facet.address
    })
    console.log(`[OK] Facet '${contract.name}' deployed with address ${facet.address}`)
  }

  console.log('Starting verification process...')
  
  const res = await verify(contracts)
  console.log('[OK] Deployed facets verified')
  return contracts
}

// deploy and verify new or changed facets
task("diamond:cut", "Compare the local diamond.json with the remote diamond")
  .addOptionalParam("address", "The diamond's address", "")
  .addOptionalParam("o", "The file to create", "diamond.json")
  .addOptionalParam("initContract", "Contract to init", "")
  .addOptionalParam("initFn", "Function to call during init", "")
  .addOptionalParam("initParams", "Parameters to pass during init", "")
  .setAction(async (args, hre) => {
    const CHAIN_ID = getChainIdByNetworkName(hre.config.defaultNetwork)
    let address = await getAddressFromArgs(args)

    await hre.run("clean")
    await hre.run("compile")

    /**@notice get contracts to deploy by comparing local and remote diamond.json */
    console.log('Louping diamond...')
    let output1 = await loupe(address, CHAIN_ID)
    console.log('[OK] Diamond louped')
    
    const diamondJson = await getDiamondJson(args.o)
    const differentiator = new DiamondDifferentiator(output1, diamondJson)
    const facetsToDeployAndVerify = differentiator.getContractsToDeploy();

    const verifiedFacets = await deployAndVerifyFacetsFromDiff(facetsToDeployAndVerify, CHAIN_ID)

    const facetsToAdd = differentiator.getFunctionsFacetsToAdd()

    /**@notice create functionSelectors for functions needed to add */
    let cut = [];

    let diamondJsonContracts = {...diamondJson.contracts}
    verifiedFacets.forEach(vf => {
      diamondJsonContracts[vf.name] = {
        name: vf.name,
        address: vf.address,
        type: 'remote'
      }
    })
    // TOODO: let diamondJsonFunctionSelectors = {...diamondJson.functionSelectors}

    for (let f of facetsToAdd) {
      let facetAddress
      if (diamondJson.contracts[f.facet].type === 'remote') {
        facetAddress = diamondJson.contracts[f.facet].address
      } else {
        facetAddress = verifiedFacets.find(vf => vf.name === f.facet).address
      }
      const {abi} = await getMetadataFromAddress(facetAddress)
      const facet = new ethers.Contract(facetAddress, abi)
  
      let fnNamesSelectors = await getFunctionsNamesSelectorsFromFacet(facet)
      let fn = fnNamesSelectors.find(ns => ns.name === f.fn)
      let cutAddressIndex = cut.findIndex(c => c.facetAddress === facetAddress && c.action === FacetCutAction.Add)
      if(cutAddressIndex === -1) {
        cut.push({
          facetAddress: facetAddress,
          action: FacetCutAction.Add,
          functionSelectors: [fn.selector]
        })
      } else {
        cut[cutAddressIndex].functionSelectors.push(fn.selector)
      }
    }

    const facetsToReplace = differentiator.getFunctionFacetsToReplace()
    for (let f of facetsToReplace) {  
      let facetAddress
      if (diamondJson.contracts[f.facet].type === 'remote') {
        facetAddress = diamondJson.contracts[f.facet].address
      } else {
        facetAddress = verifiedFacets.find(vf => vf.name === f.facet).address
      }
      const {abi} = await getMetadataFromAddress(facetAddress)
      const facet = new ethers.Contract(facetAddress, abi)
  
      let fnNamesSelectors = await getFunctionsNamesSelectorsFromFacet(facet)
      let fn = fnNamesSelectors.find(ns => ns.name === f.fn)
      let cutAddressIndex = cut.findIndex(c => c.facetAddress === facetAddress && c.action === FacetCutAction.Add)
      if(cutAddressIndex === -1) {
        cut.push({
          facetAddress: facetAddress,
          action: FacetCutAction.Replace,
          functionSelectors: [fn.selector]
        })
      } else {
        cut[cutAddressIndex].functionSelectors.push(fn.selector)
      }
    }
    
    const facetsToRemove = differentiator.getFunctionsFacetsToRemove()
    for (let f of facetsToRemove) {
      let facetAddress
      if (diamondJson.contracts[f.facet].type === 'remote') {
        facetAddress = diamondJson.contracts[f.facet].address
      } else {
        facetAddress = verifiedFacets.find(vf => vf.name === f.facet).address
      }
      const {abi} = await getMetadataFromAddress(facetAddress)
      const facet = new ethers.Contract(facetAddress, abi)
  
      let fnNamesSelectors = await getFunctionsNamesSelectorsFromFacet(facet)
      let fn = fnNamesSelectors.find(ns => ns.name === f.fn)
      let cutAddressIndex = cut.findIndex(c => c.facetAddress === facetAddress && c.action === FacetCutAction.Add)
      if(cutAddressIndex === -1) {
        cut.push({
          facetAddress: ethers.constants.AddressZero,
          action: FacetCutAction.Remove,
          functionSelectors: [fn.selector]
        })
      } else {
        cut[cutAddressIndex].functionSelectors.push(fn.selector)
      }
      if (cut[cutAddressIndex] && cut[cutAddressIndex].functionSelectors.length === fnNamesSelectors.length) {
        delete diamondJson.contracts[FacetName]
      }
    }

    /**@notice cut in facets */
    console.log(`Cutting Diamond's facets...`)
    // do the cut
    const diamondCut = await ethers.getContractAt('IDiamondCut', address)
    let tx
    let receipt
    
    // call to init function
    let initAddress = "0x0000000000000000000000000000000000000000"
    let functionCall = []

    /* if (args.rawInit !== "") {
      initFacet = 
    } else */
    if (args.initFacet !== "" && args.initFn !== "") {
      const InitContract = await ethers.getContractFactory(args.initContract)
      const initContract = await InitContract.deploy()
      initAddress = initContract.address
      await initContract.deployed()
      
      await verify([{
        name: args.initContract,
        address: initAddress
      }])
      
      const {abi} = await getMetadataFromAddress(initAddress)

      let iface = new ethers.utils.Interface(abi)

      if (args.initParams.length >= 0) {
        let params = JSON.parse(args.initParams)
        functionCall = iface.encodeFunctionData(args.initFn, params)
      } else {
        functionCall = iface.encodeFunctionData(args.initFn)
      }
    }
    tx = await diamondCut.diamondCut(cut, initAddress, functionCall, {gasLimit: 10000000})
    receipt = await tx.wait()
    if (!receipt.status) {
      throw Error(`Diamond upgrade failed: ${tx.hash}`)
    }

    diamondJson.contracts = diamondJsonContracts

    await setDiamondJson(diamondJson, args.o)

    console.log('[OK] Completed diamond cut')

    // and input facet's address and type into diamond.json
  });

task("diamond:init", "Init the diamond.json from the DIAMONDFILE")
  .addOptionalParam('diamondfile', "Use a specific DIAMONDFILE", "DIAMONDFILE")
  .addOptionalParam("o", "The file to create", "diamond.json")
  .setAction(async (args, hre) => {
    const diamondFile = fs.readFileSync(args.diamondfile)
    let commands = diamondFile.toString().split('\n').filter(cmd => !cmd.startsWith('#'))
    await runCommands(commands, args.o)
  })

module.exports = {};



/** 
 * TODOS:
 * verify DiamondInit contract - not verifying
 * include 'diamond' (w/ address and other info) in diamond.json
 */




