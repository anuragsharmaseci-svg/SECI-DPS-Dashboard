// models/index.js
const { Sequelize, DataTypes } = require("sequelize");
const contracts_table = require("./contracts_table");
const config = require("../config");
require("dotenv").config(); // Load .env variables

//select database to use (case-insensitive NODE_ENV check)
let DB_NAME = process.env.DB_NAME_TESTING;
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
  DB_NAME = process.env.DB_NAME_PRODUCTION;
}

const sequelize = new Sequelize(
  config.DB_NAME,
  config.DB_USER,
  config.DB_PASS,
  {
    host: config.DB_HOST,
    port: config.DB_PORT,
    dialect: "mysql",
    logging: false,
    pool: {
      max: Number(process.env.DB_POOL_MAX) || 20,
      min: Number(process.env.DB_POOL_MIN) || 5,
      acquire: 30000,
      idle: 10000,
    },
    dialectOptions: {
      connectTimeout: 60000,
    },
  },
);

const models = {
  DeptMaster: require("./dept_master")(sequelize, DataTypes),
  DeptStatistic: require("./dept_statistic")(sequelize, DataTypes),
  DeptEntity: require("./dept_entity")(sequelize, DataTypes),
  EntityFields: require("./entity_fields")(sequelize, DataTypes),
  EntityDocs: require("./entity_docs")(sequelize, DataTypes),
  EntityCorrespondence: require("./entity_correspondence")(
    sequelize,
    DataTypes,
  ),
  EntityIssues: require("./entity_issues")(sequelize, DataTypes),
  User: require("./user")(sequelize, DataTypes),
  UserEditAccess: require("./user_edit_access")(sequelize, DataTypes),
  UserLogs: require("./user_logs")(sequelize, DataTypes),
  ContractsTable: require("./contracts_table")(sequelize, DataTypes),
  TenderRegister: require("./tender_register")(sequelize, DataTypes),
  BusinessDevelopmentTable: require("./bd_table")(sequelize, DataTypes),
  BusinessDevelopmentMilestones: require("./bd_milestones")(
    sequelize,
    DataTypes,
  ),
  OMDGR: require("./om_dgr")(sequelize, DataTypes),
  REIADocuments: require("./reia_documents")(sequelize, DataTypes),
  OMProjectTypeMapping: require("./om_project_type_mapping")(
    sequelize,
    DataTypes,
  ),
  OmProjectTypeIssuesActions: require("./om_project_type_Issues_actions")(
    sequelize,
    DataTypes,
  ),
  OMDGRSolar: require("./om_dgr_solar")(sequelize, DataTypes),
  OMDGRSolarBESS: require("./om_dgr_solar_bess")(sequelize, DataTypes),
  PmcProject: require("./pmc_project")(sequelize, DataTypes),
  PmcMilestone: require("./pmc_milestone")(sequelize, DataTypes),
  PmcConsultancyEntity: require("./pmc_ce_entity")(sequelize, DataTypes),
  PmcConsultancyField: require("./pmc_ce_field")(sequelize, DataTypes),
  PmcCeDocument: require("./pmc_ce_document")(sequelize, DataTypes),
  PmcCeCorrespondence: require("./pmc_ce_correspondence")(sequelize, DataTypes),
  PmcCeMilestone: require("./pmc_ce_milestone")(sequelize, DataTypes),
  PmcSliceMeta: require("./pmc_slice_meta")(sequelize, DataTypes),
  PmcDprMeta: require("./pmc_dpr_meta")(sequelize, DataTypes),
  PmcBmsMeta: require("./pmc_bms_meta")(sequelize, DataTypes),
  PmcExecutionMeta: require("./pmc_execution_meta")(sequelize, DataTypes),
  ContractDocument: require("./contract_document")(sequelize, DataTypes),
  CorrespondenceOther: require("./correspondence_other")(sequelize, DataTypes),
  BmsContractDocument: require("./bms_contract_document")(sequelize, DataTypes),
  BmsCorrespondenceOther: require("./bms_correspondence_other")(sequelize, DataTypes),
  DprContractDocument: require("./dpr_contract_document")(sequelize, DataTypes),
  DprCorrespondenceOther: require("./dpr_correspondence_other")(sequelize, DataTypes),
  PmcExecutionDocument: require("./pmc_execution_document")(sequelize, DataTypes),
  PmcExecutionCorrespondence: require("./pmc_execution_correspondence")(sequelize, DataTypes),
  PmcExecutionIssue: require("./pmc_execution_issue")(sequelize, DataTypes),
  PmcDprIssue: require("./pmc_dpr_issue")(sequelize, DataTypes),
  PmcBmsIssue: require("./pmc_bms_issue")(sequelize, DataTypes),
  TariffPetition: require("./tariff_petition")(sequelize, DataTypes),
  TariffContextValue: require("./tariff_context_value")(sequelize, DataTypes),
  DeveloperPayment: require("./developer_payment")(sequelize, DataTypes),
  PowerSale: require("./power_sale")(sequelize, DataTypes),
  RegulatoryOrder: require("./regulatory_order")(sequelize, DataTypes),
  DiscomPayments: require("./discom_payment")(sequelize, DataTypes),
  StateWiseDetail: require("./state_wise_details")(sequelize, DataTypes),
  DiscomPayments: require("./discom_payment")(sequelize, DataTypes),
  OwnProject: require("./own_project")(sequelize, DataTypes),
  QaRegisteredProject: require("./qa_registered_project")(sequelize, DataTypes),
  QaBbu: require("./qa_bbu")(sequelize, DataTypes),
  QaMdcc: require("./qa_mdcc")(sequelize, DataTypes),
};

// QA associations
models.QaRegisteredProject.hasMany(models.QaBbu, { as: "bbus", foreignKey: "qa_project_id" });
models.QaRegisteredProject.hasMany(models.QaMdcc, { as: "mdccs", foreignKey: "qa_project_id" });
models.QaBbu.belongsTo(models.QaRegisteredProject, { as: "project", foreignKey: "qa_project_id" });
models.QaMdcc.belongsTo(models.QaRegisteredProject, { as: "project", foreignKey: "qa_project_id" });

Object.values(models).forEach((model) => {
  if (typeof model.associate === "function") {
    model.associate(models);
  }
});

module.exports = { sequelize, models };
