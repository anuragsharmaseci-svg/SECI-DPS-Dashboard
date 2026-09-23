"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("qa_mdcc", {
      mdcc_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.UUIDV4,
      },
      qa_project_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: "qa_registered_project",
          key: "qa_project_id",
        },
      },
      mdcc_no: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      mdcc_date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      project_details: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      rfb_details: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      ca_no: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      bbu_ref_no: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      contractor_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      contractor_address: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      bbu_sl_no: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      bbu_item_sl_no: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      item_material_description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      uom: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      mt: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      qty_as_per_bbu: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      mdcc_issued_till_date: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 0,
      },
      mdcc_issued_for: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      manufacturer: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      inspect: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      remarks: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("qa_mdcc");
  },
};